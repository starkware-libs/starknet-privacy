//! Incoming sync orchestrator.
//!
//! Composes paginated channel, subchannel, and note discovery into a
//! single [`sync_incoming_state`] call that advances a [`DiscoveryCursor`].
//!
//! Channel and subchannel processing is concurrent via [`FuturesUnordered`].

use futures::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

use tracing::{debug, instrument, trace};

use crate::discovery::incoming_channels::{discover_incoming_channels_paginated, IncomingChannel};
use crate::discovery::notes::{discover_notes_paginated, DecryptedNote};
use crate::discovery::subchannels::discover_subchannels_paginated;
use crate::discovery::DiscoveryError;
use crate::discovery::{ChannelCursor, DiscoveryCursor, SubchannelCursor};
use crate::io_budget::IoBudget;
use crate::privacy_pool::felt_hex;
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// Result of a single incoming state sync run.
#[derive(Debug, Clone, Serialize)]
pub struct SyncIncomingStateResult {
    /// Discovered incoming channels (one per sender).
    pub channels: Vec<IncomingChannel>,
    /// Discovered incoming subchannels (one per sender×token pair).
    pub subchannels: Vec<IncomingSubchannel>,
    /// Discovered notes with sender and token context.
    pub notes: Vec<DecryptedNote>,
    /// Updated cursor for the next run. Discovery is complete when
    /// `cursor.is_complete()` returns `true`.
    pub cursor: DiscoveryCursor,
}

/// Discovered data for a single incoming subchannel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingSubchannel {
    /// The sender's address (foreign key to channel).
    pub sender_addr: Felt,
    /// The token address.
    pub token: Felt,
}

/// Result of processing a single channel (internal).
struct ProcessChannelResult {
    sender_addr: Felt,
    subchannels: Vec<IncomingSubchannel>,
    notes: Vec<DecryptedNote>,
    cursor: ChannelCursor,
}

/// Result of processing a single subchannel (internal).
struct ProcessSubchannelResult {
    token: Felt,
    notes: Vec<DecryptedNote>,
    cursor: SubchannelCursor,
}

/// Runs hierarchical discovery: channels → subchannels → notes.
///
/// Each level uses cursor-based pagination. Completed subchannels and
/// channels are marked via completion flags but never pruned from the cursor.
///
/// Channel and subchannel processing is concurrent via [`FuturesUnordered`].
// TODO: Handle open notes — notes with salt==OPEN_NOTE_SALT(1) have plaintext
//       amounts, non-zero token and depositor fields (see Cairo objects.cairo
//       Note struct)
#[instrument(skip_all, fields(recipient = felt_hex(&recipient)))]
pub async fn sync_incoming_state<S: IViews>(
    pool: &S,
    recipient: Felt,
    decryption_key: &SecretFelt,
    mut cursor: DiscoveryCursor,
    budget: &IoBudget,
) -> Result<SyncIncomingStateResult, DiscoveryError> {
    debug!(
        recipient = felt_hex(&recipient),
        cursor_channels = cursor.channels.len(),
        all_processed = cursor.all_channels_processed(),
        budget = budget.remaining(),
        "incoming sync start"
    );

    // Discover new channels when there are no pending subchannel/note work.
    // On a fresh cursor this is vacuously true; on subsequent calls it fires
    // once all previously discovered channels have been fully processed.
    let channels = if cursor.all_channels_processed() {
        discover_incoming_channels_paginated(pool, recipient, decryption_key, &mut cursor, budget)
            .await?
    } else {
        Vec::new()
    };

    debug!(
        new_channels = channels.len(),
        cursor_channels = cursor.channels.len(),
        budget = budget.remaining(),
        "incoming channels discovered"
    );
    for channel in &channels {
        trace!(sender = felt_hex(&channel.sender_addr), "incoming channel");
    }

    let mut subchannels: Vec<IncomingSubchannel> = Vec::new();
    let mut notes: Vec<DecryptedNote> = Vec::new();

    // Extract incomplete channels for processing; complete ones stay in
    // the cursor. The client is responsible for pruning complete entries.
    let mut pending_futures: FuturesUnordered<_> = cursor
        .channels
        .extract_if(|_, ch| !ch.is_complete())
        .map(|(sender_addr, ch_cursor)| {
            process_channel(pool, sender_addr, ch_cursor, decryption_key, budget)
        })
        .collect();

    while let Some(result) = pending_futures.next().await {
        let ProcessChannelResult {
            sender_addr,
            subchannels: new_subchannels,
            notes: new_notes,
            cursor: new_cursor,
        } = result?;
        subchannels.extend(new_subchannels);
        notes.extend(new_notes);
        cursor.channels.insert(sender_addr, new_cursor);
    }

    debug!(
        subchannels = subchannels.len(),
        notes = notes.len(),
        cursor_complete = cursor.is_complete(),
        budget = budget.remaining(),
        "incoming sync done"
    );

    Ok(SyncIncomingStateResult {
        channels,
        subchannels,
        notes,
        cursor,
    })
}

/// Processes a single channel: discovers subchannels, then runs note
/// discovery for each subchannel concurrently via [`FuturesUnordered`].
#[instrument(skip_all, fields(sender = felt_hex(&sender_addr)))]
async fn process_channel<S: IViews>(
    pool: &S,
    sender_addr: Felt,
    mut cursor: ChannelCursor,
    decryption_key: &SecretFelt,
    budget: &IoBudget,
) -> Result<ProcessChannelResult, DiscoveryError> {
    let channel_key = cursor.channel_key.ok_or_else(|| {
        DiscoveryError::InvalidCursor("channel_key is required for incoming channel".into())
    })?;

    discover_subchannels_paginated(pool, channel_key, &mut cursor, budget).await?;

    // Extract incomplete subchannels for processing; complete ones stay
    // in the cursor. The client is responsible for pruning complete entries.
    let mut pending_futures: FuturesUnordered<_> = cursor
        .subchannels
        .extract_if(|_, sc| !sc.note_discovery_complete)
        .map(|(token, sc_cursor)| {
            process_subchannel(pool, channel_key, token, sc_cursor, decryption_key, budget)
        })
        .collect();

    let mut subchannels: Vec<IncomingSubchannel> = Vec::new();
    let mut notes: Vec<DecryptedNote> = Vec::new();
    while let Some(result) = pending_futures.next().await {
        let ProcessSubchannelResult {
            token,
            notes: new_notes,
            cursor: new_cursor,
        } = result?;
        subchannels.push(IncomingSubchannel { sender_addr, token });
        // Enrich notes with sender and token context.
        for mut note in new_notes {
            note.sender_addr = sender_addr;
            note.token = token;
            notes.push(note);
        }
        cursor.subchannels.insert(token, new_cursor);
    }

    Ok(ProcessChannelResult {
        sender_addr,
        subchannels,
        notes,
        cursor,
    })
}

/// Processes a single subchannel: discovers notes via pagination.
#[instrument(skip_all, fields(token = felt_hex(&token)))]
async fn process_subchannel<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    mut cursor: SubchannelCursor,
    decryption_key: &SecretFelt,
    budget: &IoBudget,
) -> Result<ProcessSubchannelResult, DiscoveryError> {
    if cursor.note_discovery_complete {
        return Ok(ProcessSubchannelResult {
            token,
            notes: Vec::new(),
            cursor,
        });
    }

    let (notes, has_more) = discover_notes_paginated(
        pool,
        channel_key,
        token,
        &mut cursor,
        decryption_key,
        budget,
    )
    .await?;

    cursor.note_discovery_complete = !has_more;

    Ok(ProcessSubchannelResult {
        token,
        notes,
        cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{
        COST_CHANNEL_INFO, COST_NOTE, COST_NOTE_PROBING, COST_NUM_CHANNELS, COST_SUBCHANNEL_INFO,
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
    /// | 5    | 4+     | Subchannels skipped + batched note scan → all done |
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
        let sender_addr = f.constants.alice_address;
        assert!(
            out.cursor.channels.contains_key(&sender_addr),
            "step 2: cursor keyed by sender (Alice)"
        );

        // Step 3: budget = COST_SUBCHANNEL_INFO (2)
        // Channel discovery skipped (cursor.channels non-empty). Discovers
        // subchannel 0 (STRK). Can't check sentinel (needs another
        // COST_SUBCHANNEL_INFO).
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
        // Channel discovery skipped (cursor.channels non-empty). Reads
        // subchannel index 1 → sentinel (salt=0). Budget=0, note discovery
        // fails (needs COST_NOTE_PROBING=1 for initial probe).
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

        // Step 5: budget = 2 * COST_NOTE_PROBING + COST_NOTE (4)
        // Subchannels skipped (total cached). Notes discovery:
        // Exponential probe: 2 probes (offsets 0, 1) → hit at 0, miss at 1. Cost = 2.
        // Linear scan: 1 note at index 0 → COST_NOTE (2: get_note + nullifier). Cost = 2.
        // Bob's note is spent → filtered. Total = 4.
        // batch_budget=2 limits the probe batch to 2 probes.
        let budget = IoBudget::new(2 * COST_NOTE_PROBING + COST_NOTE).with_batch_budget(2);
        let out = sync_incoming_state(&backend, recipient, &decryption_key, out.cursor, &budget)
            .await
            .unwrap();

        assert!(out.cursor.is_complete(), "step 5: all discovery complete");
        assert_eq!(
            out.notes.len(),
            0,
            "step 5: note discovered but spent (filtered out)"
        );
    }
}
