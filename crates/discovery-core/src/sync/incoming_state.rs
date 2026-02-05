//! Incoming sync orchestrator.
//!
//! Composes paginated channel, subchannel, and note discovery into a
//! single [`sync_incoming_state`] call that advances a [`DiscoveryCursor`].
//!
//! Channel and subchannel processing is parallelised via [`tokio::task::JoinSet`].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;
use tokio::task::JoinSet;

use crate::discovery::cursor::{ChannelCursor, DiscoveryCursor, SubchannelCursor};
use crate::discovery::incoming_channels::discover_channels_paginated;
use crate::discovery::notes::{discover_notes_paginated, DecryptedNote};
use crate::discovery::subchannels::discover_subchannels_paginated;
use crate::discovery::DiscoveryError;
use crate::io_budget::IoBudget;
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// Output from a single discovery run.
#[derive(Debug, Clone, Serialize)]
pub struct DiscoveryOutput {
    /// Discovered data per channel, keyed by channel_key.
    pub channels: HashMap<Felt, ChannelOutput>,
    /// Updated cursor for the next run. Fully-discovered channels and
    /// subchannels are pruned. An empty `cursor.channels` map means
    /// all discovery is complete.
    pub cursor: DiscoveryCursor,
}

/// Discovered data for a single channel within a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelOutput {
    /// Sender address for this channel.
    pub sender_addr: Felt,
    /// Discovered notes per subchannel, keyed by token address.
    pub subchannels: HashMap<Felt, Vec<DecryptedNote>>,
}

/// Result of processing a single channel (internal).
struct ChannelResult {
    channel_key: Felt,
    output: ChannelOutput,
    /// `None` means fully discovered — prune from cursor.
    cursor: Option<ChannelCursor>,
}

/// Result of processing a single subchannel (internal).
struct SubchannelResult {
    token: Felt,
    notes: Vec<DecryptedNote>,
    /// `None` means fully discovered — prune from cursor.
    cursor: Option<SubchannelCursor>,
}

/// Runs hierarchical discovery: channels → subchannels → notes.
///
/// Each level uses cursor-based pagination. Fully-discovered subchannels
/// and channels are pruned from the cursor so subsequent calls skip them.
///
/// Channel and subchannel processing is parallelised via [`JoinSet`].
// TODO: Handle open notes — notes with salt==OPEN_NOTE_SALT(1) have plaintext
//       amounts, non-zero token and depositor fields (see Cairo objects.cairo
//       Note struct)
pub async fn sync_incoming_state<S>(
    pool: &S,
    recipient: Felt,
    decryption_key: &SecretFelt,
    mut cursor: DiscoveryCursor,
    budget: &IoBudget,
) -> Result<DiscoveryOutput, DiscoveryError>
where
    S: IViews + Clone + Send + Sync + 'static,
{
    discover_channels_paginated(pool, recipient, decryption_key, &mut cursor, budget).await?;

    if cursor.channels.is_empty() {
        return Ok(DiscoveryOutput {
            channels: HashMap::new(),
            cursor,
        });
    }

    // TODO(security): Cap cursor.channels size before spawning tasks — the
    //   HashMap is deserialized from an untrusted request with no size limit.
    //   An attacker can send 50K+ entries within the 2MB body limit, each
    //   spawning a tokio task → OOM / scheduler exhaustion.
    //   Fix: reject or truncate cursor.channels to a max size (e.g., 256).
    let channels = std::mem::take(&mut cursor.channels);
    let mut join_set = JoinSet::new();
    for (channel_key, ch_cursor) in channels {
        let pool = pool.clone();
        let budget = budget.clone();
        let key = decryption_key.clone();
        join_set.spawn(async move {
            process_channel(&pool, channel_key, ch_cursor, &key, &budget).await
        });
    }

    let mut channels_output: HashMap<Felt, ChannelOutput> = HashMap::new();
    while let Some(join_result) = join_set.join_next().await {
        let result = join_result.map_err(|e| DiscoveryError::TaskPanicked(e.to_string()))??;
        channels_output.insert(result.channel_key, result.output);
        if let Some(ch_cursor) = result.cursor {
            cursor.channels.insert(result.channel_key, ch_cursor);
        }
    }

    Ok(DiscoveryOutput {
        channels: channels_output,
        cursor,
    })
}

/// Processes a single channel: discovers subchannels, then spawns note
/// discovery for each subchannel concurrently via [`JoinSet`].
async fn process_channel<S>(
    pool: &S,
    channel_key: Felt,
    mut cursor: ChannelCursor,
    decryption_key: &SecretFelt,
    budget: &IoBudget,
) -> Result<ChannelResult, DiscoveryError>
where
    S: IViews + Clone + Send + Sync + 'static,
{
    let sender_addr = cursor.sender_addr;

    discover_subchannels_paginated(pool, channel_key, &mut cursor, budget).await?;

    let subchannels: Vec<(Felt, SubchannelCursor)> = std::mem::take(&mut cursor.subchannels)
        .into_iter()
        .collect();

    // TODO(security): Cap cursor.subchannels size before spawning tasks —
    //   same unbounded-HashMap attack vector as cursor.channels above,
    //   multiplied per channel (N channels × M subchannels = N×M tasks).
    let mut join_set = JoinSet::new();
    for (token, sc_cursor) in subchannels {
        let pool = pool.clone();
        let budget = budget.clone();
        let key = decryption_key.clone();
        join_set.spawn(async move {
            process_subchannel(&pool, channel_key, token, sc_cursor, &key, &budget).await
        });
    }

    let mut subchannel_notes: HashMap<Felt, Vec<DecryptedNote>> = HashMap::new();
    while let Some(join_result) = join_set.join_next().await {
        let result = join_result.map_err(|e| DiscoveryError::TaskPanicked(e.to_string()))??;
        subchannel_notes.insert(result.token, result.notes);
        if let Some(sc_cursor) = result.cursor {
            cursor.subchannels.insert(result.token, sc_cursor);
        }
    }

    let fully_done = cursor.total_n_subchannels.is_some() && cursor.subchannels.is_empty();

    Ok(ChannelResult {
        channel_key,
        output: ChannelOutput {
            sender_addr,
            subchannels: subchannel_notes,
        },
        cursor: if fully_done { None } else { Some(cursor) },
    })
}

/// Processes a single subchannel: discovers notes via pagination.
async fn process_subchannel<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    mut cursor: SubchannelCursor,
    decryption_key: &SecretFelt,
    budget: &IoBudget,
) -> Result<SubchannelResult, DiscoveryError> {
    let (notes, has_more) = discover_notes_paginated(
        pool,
        channel_key,
        token,
        &mut cursor,
        decryption_key,
        budget,
    )
    .await?;

    Ok(SubchannelResult {
        token,
        notes,
        cursor: if has_more { Some(cursor) } else { None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{COST_CHANNEL_INFO, COST_NOTE, COST_NUM_CHANNELS, COST_SUBCHANNEL_INFO};
    use crate::storage_backend::MockBackend;
    use crate::test_fixtures::load_devnet_fixture;

    /// Exercises `sync_incoming_state` with precise budget control, verifying
    /// each pagination step via cursor state: channel count fetch, channel
    /// discovery, subchannel discovery, subchannel sentinel, note discovery,
    /// note sentinel.
    ///
    /// Recipient: Bob — 1 incoming channel (from Alice), 1 subchannel (STRK),
    /// 1 note.
    ///
    /// | Step | Budget | What happens                                      |
    /// |------|--------|---------------------------------------------------|
    /// | 1    | 1      | Channel count fetch                               |
    /// | 2    | 3      | Channel 0 discovered                              |
    /// | 3    | 2      | Subchannel 0 (STRK) discovered                    |
    /// | 4    | 2      | Subchannel sentinel → total cached                |
    /// | 5    | 1      | Subchannels skipped (cached) + note 0 discovered  |
    /// | 6    | 1      | Subchannels skipped + note sentinel → all done    |
    #[tokio::test]
    async fn test_sync_incoming_state_step_by_step_pagination() {
        let f = load_devnet_fixture();
        let backend = MockBackend::new(f.slots);
        let recipient = f.constants.bob_address;
        let decryption_key = SecretFelt::new(f.constants.bob_viewing_key);

        // Step 1: budget = COST_NUM_CHANNELS (1)
        // Fetches total_n_channels = 1. No budget left for channel discovery.
        let budget = IoBudget::new(COST_NUM_CHANNELS);
        let cursor = DiscoveryCursor::default();
        let out = sync_incoming_state(&backend, recipient, &decryption_key, cursor, &budget)
            .await
            .unwrap();

        assert_eq!(out.cursor.total_n_channels, Some(1), "step 1: total cached");
        assert_eq!(
            out.cursor.last_channel_index, None,
            "step 1: no channel discovered yet"
        );

        // Step 2: budget = COST_CHANNEL_INFO (3)
        // Count is cached. Discovers channel 0. Budget=0, subchannel discovery
        // fails (needs COST_SUBCHANNEL_INFO=2).
        let budget = IoBudget::new(COST_CHANNEL_INFO);
        let out = sync_incoming_state(&backend, recipient, &decryption_key, out.cursor, &budget)
            .await
            .unwrap();

        assert_eq!(
            out.cursor.last_channel_index,
            Some(0),
            "step 2: channel 0 discovered"
        );
        assert_eq!(out.cursor.channels.len(), 1, "step 2: 1 channel in cursor");
        let channel_key = *out.cursor.channels.keys().next().unwrap();
        assert_eq!(
            out.channels[&channel_key].sender_addr, f.constants.alice_address,
            "step 2: sender is Alice"
        );

        // Step 3: budget = COST_SUBCHANNEL_INFO (2)
        // No new channels (already done). Discovers subchannel 0 (STRK).
        // Can't check sentinel (needs another COST_SUBCHANNEL_INFO).
        let budget = IoBudget::new(COST_SUBCHANNEL_INFO);
        let out = sync_incoming_state(&backend, recipient, &decryption_key, out.cursor, &budget)
            .await
            .unwrap();

        assert!(
            out.cursor.channels.contains_key(&channel_key),
            "step 3: channel still in cursor (not fully done)"
        );
        assert_eq!(
            out.cursor.channels[&channel_key].subchannels.len(),
            1,
            "step 3: 1 subchannel found"
        );
        let subchannel_token = *out.cursor.channels[&channel_key]
            .subchannels
            .keys()
            .next()
            .unwrap();
        assert_eq!(
            subchannel_token, f.constants.strk_token,
            "step 3: subchannel is STRK"
        );

        // Step 4: budget = COST_SUBCHANNEL_INFO (2)
        // Reads subchannel index 1 → sentinel (salt=0).
        // Budget=0, note discovery fails (needs COST_NOTE=1).
        let budget = IoBudget::new(COST_SUBCHANNEL_INFO);
        let out = sync_incoming_state(&backend, recipient, &decryption_key, out.cursor, &budget)
            .await
            .unwrap();

        assert!(
            out.cursor.channels.contains_key(&channel_key),
            "step 4: channel still in cursor (notes pending)"
        );
        assert!(
            out.cursor.channels[&channel_key]
                .subchannels
                .contains_key(&subchannel_token),
            "step 4: subchannel still in cursor (notes not started)"
        );

        // Step 5: budget = COST_NOTE (2)
        // Subchannels skipped (total cached). Discovers note 0 (1 get_note +
        // 1 nullifier_exists). Note is spent → filtered out. Budget=0, can't
        // check sentinel.
        let budget = IoBudget::new(COST_NOTE);
        let out = sync_incoming_state(&backend, recipient, &decryption_key, out.cursor, &budget)
            .await
            .unwrap();

        assert!(
            out.cursor.channels.contains_key(&channel_key),
            "step 5: channel still in cursor (note sentinel not checked)"
        );
        let notes = &out.channels[&channel_key].subchannels[&subchannel_token];
        assert_eq!(
            notes.len(),
            0,
            "step 5: note discovered but spent (filtered out)"
        );

        // Step 6: budget = COST_NOTE (2)
        // Subchannels skipped (total cached). Reads note index 1 → sentinel
        // (packed_amount=0 → break, no nullifier check). 1 budget unit unused.
        // All done: subchannel + channel pruned from cursor.
        let budget = IoBudget::new(COST_NOTE);
        let out = sync_incoming_state(&backend, recipient, &decryption_key, out.cursor, &budget)
            .await
            .unwrap();

        assert!(
            out.cursor.channels.is_empty(),
            "step 6: cursor empty (all discovery complete)"
        );
        assert_eq!(
            out.channels[&channel_key].subchannels[&subchannel_token].len(),
            0,
            "step 6: no new notes discovered"
        );
    }
}
