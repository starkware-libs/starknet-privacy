//! Incoming sync orchestrator.
//!
//! Composes paginated channel, subchannel, and note discovery into a
//! single [`sync_incoming_state`] call that advances a [`DiscoveryCursor`].
//!
//! Channel and subchannel processing is concurrent via [`FuturesUnordered`].

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

use tracing::{debug, instrument, trace};

use super::{discover_and_process_subchannels, process_pending_channels};
use crate::discovery::incoming_channels::{discover_incoming_channels_paginated, IncomingChannel};
use crate::discovery::notes::{discover_notes_paginated, DecryptedNote};
use crate::discovery::{ChannelCursor, CursorLimits, DiscoveryCursor, DiscoveryError};
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
    viewing_key: &SecretFelt,
    mut cursor: DiscoveryCursor,
    cursor_limits: CursorLimits,
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
    let new_channels = if cursor.all_channels_processed() {
        discover_incoming_channels_paginated(
            pool,
            recipient,
            viewing_key,
            &mut cursor,
            cursor_limits.max_channels,
            budget,
        )
        .await?
    } else {
        Vec::new()
    };

    debug!(
        new_channels = new_channels.len(),
        cursor_channels = cursor.channels.len(),
        budget = budget.remaining(),
        "incoming channels discovered"
    );
    for channel in &new_channels {
        trace!(sender = felt_hex(&channel.sender_addr), "incoming channel");
    }

    let mut new_subchannels: Vec<IncomingSubchannel> = Vec::new();
    let mut new_notes: Vec<DecryptedNote> = Vec::new();

    // Process incomplete channels concurrently.
    let channel_results = process_pending_channels(&mut cursor, |sender_addr, ch_cursor| {
        process_channel(
            pool,
            sender_addr,
            ch_cursor,
            viewing_key,
            cursor_limits.max_subchannels,
            budget,
        )
    })
    .await?;

    for (_, (channel_subchannels, channel_notes)) in channel_results {
        new_subchannels.extend(channel_subchannels);
        new_notes.extend(channel_notes);
    }

    debug!(
        subchannels = new_subchannels.len(),
        notes = new_notes.len(),
        cursor_complete = cursor.is_complete(),
        budget = budget.remaining(),
        "incoming sync done"
    );

    Ok(SyncIncomingStateResult {
        channels: new_channels,
        subchannels: new_subchannels,
        notes: new_notes,
        cursor,
    })
}

/// Processes a single channel: discovers subchannels, then runs note
/// discovery for each subchannel concurrently.
#[instrument(skip_all, fields(sender = felt_hex(&sender_addr)))]
async fn process_channel<S: IViews>(
    pool: &S,
    sender_addr: Felt,
    cursor: ChannelCursor,
    viewing_key: &SecretFelt,
    max_cursor_subchannels: usize,
    budget: &IoBudget,
) -> Result<((Vec<IncomingSubchannel>, Vec<DecryptedNote>), ChannelCursor), DiscoveryError> {
    let (sc_results, cursor) = discover_and_process_subchannels(
        pool,
        cursor,
        max_cursor_subchannels,
        budget,
        |channel_key, token, mut sc_cursor| async move {
            if sc_cursor.note_discovery_complete {
                return Ok((Vec::new(), sc_cursor));
            }
            let notes = discover_notes_paginated(
                pool, channel_key, token, &mut sc_cursor, viewing_key, budget,
            )
            .await?;
            Ok((notes, sc_cursor))
        },
    )
    .await?;

    let mut subchannels = Vec::new();
    let mut notes = Vec::new();
    for (token, token_notes) in sc_results {
        subchannels.push(IncomingSubchannel { sender_addr, token });
        // Enrich notes with sender and token context (see decrypt_note:
        // sender_addr and token are initialized to Felt::ZERO).
        for mut note in token_notes {
            debug_assert_eq!(note.sender_addr, Felt::ZERO, "sender_addr already set");
            debug_assert_eq!(note.token, Felt::ZERO, "token already set");
            note.sender_addr = sender_addr;
            note.token = token;
            notes.push(note);
        }
    }

    Ok(((subchannels, notes), cursor))
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
        let viewing_key = SecretFelt::new(f.constants.bob_viewing_key);

        // Step 1: budget = COST_NUM_CHANNELS (1)
        // Fetches total_n_channels = 1. No budget left for channel discovery.
        let budget = IoBudget::new(COST_NUM_CHANNELS);
        let cursor = DiscoveryCursor::default();
        let out = sync_incoming_state(
            &backend,
            recipient,
            &viewing_key,
            cursor,
            CursorLimits {
                max_channels: 1024,
                max_subchannels: 1024,
            },
            &budget,
        )
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
        let out = sync_incoming_state(
            &backend,
            recipient,
            &viewing_key,
            out.cursor,
            CursorLimits {
                max_channels: 1024,
                max_subchannels: 1024,
            },
            &budget,
        )
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
        let out = sync_incoming_state(
            &backend,
            recipient,
            &viewing_key,
            out.cursor,
            CursorLimits {
                max_channels: 1024,
                max_subchannels: 1024,
            },
            &budget,
        )
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
        let out = sync_incoming_state(
            &backend,
            recipient,
            &viewing_key,
            out.cursor,
            CursorLimits {
                max_channels: 1024,
                max_subchannels: 1024,
            },
            &budget,
        )
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

        // Step 5: Subchannels skipped (total cached). Notes discovery:
        // Exponential probe: 11 offsets [0,1,3,7,...,1023] consumed greedily,
        // but breaks at offset 1 (empty). Hit at 0, miss at 1. Cost = 11.
        // Linear scan: 1 note at index 0 → COST_NOTE (2: get_note + nullifier).
        // Bob's note is spent → filtered. Total = 13.
        let budget = IoBudget::new(11 * COST_NOTE_PROBING + COST_NOTE);
        let out = sync_incoming_state(
            &backend,
            recipient,
            &viewing_key,
            out.cursor,
            CursorLimits {
                max_channels: 1024,
                max_subchannels: 1024,
            },
            &budget,
        )
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
