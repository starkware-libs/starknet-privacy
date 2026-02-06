//! Incoming sync orchestrator.
//!
//! Composes paginated channel, subchannel, and note discovery into a
//! single [`sync_incoming_state`] call that advances a [`DiscoveryCursor`].
//!
//! Channel and subchannel processing is concurrent via [`FuturesUnordered`].

use std::collections::HashMap;

use futures::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

use crate::discovery::cursor::{ChannelCursor, DiscoveryCursor, SubchannelCursor};
use crate::discovery::incoming_channels::discover_incoming_channels_paginated;
use crate::discovery::notes::{discover_notes_paginated, DecryptedNote};
use crate::discovery::subchannels::discover_subchannels_paginated;
use crate::discovery::DiscoveryError;
use crate::io_budget::IoBudget;
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// Output from a single discovery run.
#[derive(Debug, Clone, Serialize)]
pub struct DiscoveryOutput {
    /// Discovered data per channel, keyed by sender address.
    pub channels: HashMap<Felt, ChannelOutput>,
    /// Updated cursor for the next run. Fully-discovered channels and
    /// subchannels are pruned. An empty `cursor.channels` map means
    /// all discovery is complete.
    pub cursor: DiscoveryCursor,
}

/// Discovered data for a single channel within a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelOutput {
    /// Channel key (set for incoming sync, None for outgoing).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_key: Option<Felt>,
    /// Discovered notes per subchannel, keyed by token address.
    pub subchannels: HashMap<Felt, Vec<DecryptedNote>>,
}

/// Result of processing a single channel (internal).
struct ChannelResult {
    sender_addr: Felt,
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
/// Channel and subchannel processing is concurrent via [`FuturesUnordered`].
// TODO: Handle open notes — notes with salt==OPEN_NOTE_SALT(1) have plaintext
//       amounts, non-zero token and depositor fields (see Cairo objects.cairo
//       Note struct)
pub async fn sync_incoming_state<S: IViews>(
    pool: &S,
    recipient: Felt,
    decryption_key: &SecretFelt,
    mut cursor: DiscoveryCursor,
    budget: &IoBudget,
) -> Result<DiscoveryOutput, DiscoveryError> {
    discover_incoming_channels_paginated(pool, recipient, decryption_key, &mut cursor, budget)
        .await?;

    if cursor.channels.is_empty() {
        return Ok(DiscoveryOutput {
            channels: HashMap::new(),
            cursor,
        });
    }

    // TODO(security): Cap cursor.channels size — the HashMap is deserialized
    //   from an untrusted request with no size limit. An attacker can send 50K+
    //   entries within the 2MB body limit → OOM.
    //   Fix: reject or truncate cursor.channels to a max size (e.g., 256).
    let channels = std::mem::take(&mut cursor.channels);
    let mut futs: FuturesUnordered<_> = channels
        .into_iter()
        .map(|(sender_addr, ch_cursor)| {
            process_channel(pool, sender_addr, ch_cursor, decryption_key, budget)
        })
        .collect();

    let mut channels_output: HashMap<Felt, ChannelOutput> = HashMap::new();
    while let Some(result) = futs.next().await {
        let result = result?;
        channels_output.insert(result.sender_addr, result.output);
        if let Some(ch_cursor) = result.cursor {
            cursor.channels.insert(result.sender_addr, ch_cursor);
        }
    }

    Ok(DiscoveryOutput {
        channels: channels_output,
        cursor,
    })
}

/// Processes a single channel: discovers subchannels, then runs note
/// discovery for each subchannel concurrently via [`FuturesUnordered`].
async fn process_channel<S: IViews>(
    pool: &S,
    sender_addr: Felt,
    mut cursor: ChannelCursor,
    decryption_key: &SecretFelt,
    budget: &IoBudget,
) -> Result<ChannelResult, DiscoveryError> {
    let channel_key = cursor.channel_key.ok_or_else(|| {
        DiscoveryError::InvalidCursor("channel_key is required for incoming channel".into())
    })?;

    discover_subchannels_paginated(pool, channel_key, &mut cursor, budget).await?;

    // TODO(security): Cap cursor.subchannels size — same unbounded-HashMap
    //   attack vector as cursor.channels, multiplied per channel.
    let subchannels = std::mem::take(&mut cursor.subchannels);
    let mut futs: FuturesUnordered<_> = subchannels
        .into_iter()
        .map(|(token, sc_cursor)| {
            process_subchannel(pool, channel_key, token, sc_cursor, decryption_key, budget)
        })
        .collect();

    let mut subchannel_notes: HashMap<Felt, Vec<DecryptedNote>> = HashMap::new();
    while let Some(result) = futs.next().await {
        let result = result?;
        subchannel_notes.insert(result.token, result.notes);
        if let Some(sc_cursor) = result.cursor {
            cursor.subchannels.insert(result.token, sc_cursor);
        }
    }

    let fully_done = cursor.total_n_subchannels.is_some() && cursor.subchannels.is_empty();

    Ok(ChannelResult {
        sender_addr,
        output: ChannelOutput {
            channel_key: Some(channel_key),
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
    use crate::discovery::{
        COST_CHANNEL_INFO, COST_NOTE_PROBING, COST_NUM_CHANNELS, COST_SUBCHANNEL_INFO,
    };
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
    /// | 5    | 4      | Subchannels skipped + batched note scan → all done |
    #[tokio::test]
    async fn test_sync_incoming_state_step_by_step_pagination() {
        let f = load_devnet_fixture();
        let backend = MockBackend::new(f.slots);
        let recipient = f.constants.bob_address;
        let decryption_key = SecretFelt::new(f.constants.bob_viewing_key);

        // Step 1: budget = COST_NUM_CHANNELS (1)
        // Fetches total_n_channels = 1. No budget left for channel discovery.
        let budget = IoBudget::new(COST_NUM_CHANNELS);
        let cursor = DiscoveryCursor {
            discover_channels: true,
            ..Default::default()
        };
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
        let sender_addr = f.constants.alice_address;
        assert!(
            out.cursor.channels.contains_key(&sender_addr),
            "step 2: cursor keyed by sender (Alice)"
        );

        // Step 3: budget = COST_SUBCHANNEL_INFO (2)
        // No new channels (already done). Discovers subchannel 0 (STRK).
        // Can't check sentinel (needs another COST_SUBCHANNEL_INFO).
        let budget = IoBudget::new(COST_SUBCHANNEL_INFO);
        let out = sync_incoming_state(&backend, recipient, &decryption_key, out.cursor, &budget)
            .await
            .unwrap();

        assert!(
            out.cursor.channels.contains_key(&sender_addr),
            "step 3: channel still in cursor (not fully done)"
        );
        assert_eq!(
            out.cursor.channels[&sender_addr].subchannels.len(),
            1,
            "step 3: 1 subchannel found"
        );
        let subchannel_token = *out.cursor.channels[&sender_addr]
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
        // Budget=0, note discovery fails (needs COST_NOTE_PROBING=1 for initial probe).
        let budget = IoBudget::new(COST_SUBCHANNEL_INFO);
        let out = sync_incoming_state(&backend, recipient, &decryption_key, out.cursor, &budget)
            .await
            .unwrap();

        assert!(
            out.cursor.channels.contains_key(&sender_addr),
            "step 4: channel still in cursor (notes pending)"
        );
        assert!(
            out.cursor.channels[&sender_addr]
                .subchannels
                .contains_key(&subchannel_token),
            "step 4: subchannel still in cursor (notes not started)"
        );

        // Step 5: budget = 2 * COST_NOTE_PROBING + COST_NOTE_PROBING (3)
        // Subchannels skipped (total cached). Notes discovery:
        // Exponential probe: 2 probes (offsets 0, 1) → hit at 0, miss at 1. Cost = 2.
        // Single-note optimization: 1 nullifier check. Cost = 1.
        // Bob's note is spent → filtered. Total = 3.
        // batch_budget=2 limits the probe batch to 2 probes, leaving 1 for nullifier.
        let budget = IoBudget::new(2 * COST_NOTE_PROBING + COST_NOTE_PROBING).with_batch_budget(2);
        let out = sync_incoming_state(&backend, recipient, &decryption_key, out.cursor, &budget)
            .await
            .unwrap();

        assert!(
            out.cursor.channels.is_empty(),
            "step 5: cursor empty (all discovery complete)"
        );
        let notes = &out.channels[&sender_addr].subchannels[&subchannel_token];
        assert_eq!(
            notes.len(),
            0,
            "step 5: note discovered but spent (filtered out)"
        );
    }
}
