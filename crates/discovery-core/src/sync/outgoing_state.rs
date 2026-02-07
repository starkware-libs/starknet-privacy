//! Outgoing sync orchestrator.
//!
//! Composes paginated outgoing channel, subchannel, and note-index discovery
//! into a single [`sync_outgoing_state`] call that advances a [`DiscoveryCursor`].
//!
//! Channel and subchannel processing is concurrent via [`FuturesUnordered`].

use std::collections::HashSet;

use futures::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

use tracing::{debug, instrument, trace};

use crate::discovery::last_note_index::find_last_note_index_paginated;
use crate::discovery::outgoing_channels::{
    discover_outgoing_channels_paginated, precompute_channels, OutgoingChannel,
};
use crate::discovery::subchannels::discover_subchannels_paginated;
use crate::discovery::DiscoveryError;
use crate::discovery::{ChannelCursor, DiscoveryCursor, SubchannelCursor};
use crate::io_budget::IoBudget;
use crate::privacy_pool::felt_hex;
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// Output from a single outgoing discovery run.
#[derive(Debug, Clone, Serialize)]
pub struct OutgoingDiscoveryOutput {
    /// Discovered outgoing channels (one per recipient). Includes both
    /// on-chain channels (`precomputed: false`) and precomputed channels
    /// for requested recipients (`precomputed: true`).
    pub channels: Vec<OutgoingChannel>,
    /// Discovered outgoing subchannels (one per recipient×token pair).
    pub subchannels: Vec<OutgoingSubchannel>,
    /// Updated cursor for the next run.
    pub cursor: DiscoveryCursor,
}

/// Discovered data for a single outgoing subchannel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutgoingSubchannel {
    /// The recipient's address (foreign key to channel).
    pub recipient_addr: Felt,
    /// The token address.
    pub token: Felt,
    /// Last note index in this subchannel, or `None` if no notes exist.
    pub last_note_index: Option<u64>,
}

/// Result of processing a single outgoing channel (internal).
struct OutgoingChannelResult {
    recipient_addr: Felt,
    subchannels: Vec<OutgoingSubchannel>,
    cursor: ChannelCursor,
}

/// Result of processing a single outgoing subchannel (internal).
struct OutgoingSubchannelResult {
    token: Felt,
    last_note_index: Option<u64>,
    cursor: SubchannelCursor,
}

/// Runs hierarchical outgoing discovery: channels → subchannels → note index probing.
///
/// Each level uses cursor-based pagination. Completed subchannels and
/// channels are marked via completion flags but never pruned from the cursor.
///
/// Channel and subchannel processing is concurrent via [`FuturesUnordered`].
///
/// When `recipients` is provided, also precomputes channels for recipients
/// that have no discovered on-chain channel.
#[instrument(skip_all, fields(sender = felt_hex(&sender_addr)))]
pub async fn sync_outgoing_state<S: IViews>(
    pool: &S,
    sender_addr: Felt,
    decryption_key: &SecretFelt,
    mut cursor: DiscoveryCursor,
    budget: &IoBudget,
    recipients: Option<&HashSet<Felt>>,
) -> Result<OutgoingDiscoveryOutput, DiscoveryError> {
    debug!(
        sender = felt_hex(&sender_addr),
        cursor_channels = cursor.channels.len(),
        all_processed = cursor.all_channels_processed(),
        budget = budget.remaining(),
        "outgoing sync start"
    );

    // Discover new channels when there are no pending subchannel/note work.
    // On a fresh cursor this is vacuously true; on subsequent calls it fires
    // once all previously discovered channels have been fully processed.
    let mut channels = if cursor.all_channels_processed() {
        discover_outgoing_channels_paginated(
            pool,
            sender_addr,
            decryption_key,
            &mut cursor,
            budget,
            recipients,
        )
        .await?
    } else {
        Vec::new()
    };

    debug!(
        discovered = channels.len(),
        cursor_channels = cursor.channels.len(),
        budget = budget.remaining(),
        "outgoing channels discovered"
    );
    if tracing::enabled!(tracing::Level::TRACE) {
        for channel in &channels {
            trace!(
                recipient = felt_hex(&channel.recipient_addr),
                "outgoing channel"
            );
        }
    }

    // Extract incomplete channels for processing; complete ones stay in
    // the cursor. The client is responsible for pruning complete entries.
    let mut pending_futures: FuturesUnordered<_> = cursor
        .channels
        .extract_if(|_, ch| !ch.is_complete())
        .map(|(recipient_addr, ch_cursor)| {
            process_outgoing_channel(pool, recipient_addr, ch_cursor, budget)
        })
        .collect();

    let mut subchannels: Vec<OutgoingSubchannel> = Vec::new();
    while let Some(result) = pending_futures.next().await {
        let result = result?;
        subchannels.extend(result.subchannels);
        cursor.channels.insert(result.recipient_addr, result.cursor);
    }

    // Precompute channels for requested recipients without an on-chain
    // channel. Done after subchannel/note processing so the client gets
    // complete on-chain data alongside precomputed channels in one response.
    if cursor.channel_discovery_complete {
        if let Some(r) = recipients {
            // May overlap with existing on-chain channels when the client
            // prunes complete channels from the cursor but keeps the full
            // recipients list. The SDK handles this by letting real channels
            // take precedence over precomputed ones.
            let missing_addrs: Vec<Felt> = r
                .iter()
                .copied()
                .filter(|addr| !cursor.channels.contains_key(addr))
                .collect();
            let precomputed_channels =
                precompute_channels(pool, sender_addr, decryption_key, &missing_addrs, budget)
                    .await?;
            channels.extend(precomputed_channels);
        }
    }

    Ok(OutgoingDiscoveryOutput {
        channels,
        subchannels,
        cursor,
    })
}

/// Processes a single outgoing channel: discovers subchannels, then runs
/// note-index probing for each subchannel concurrently via [`FuturesUnordered`].
#[instrument(skip_all, fields(recipient = felt_hex(&recipient_addr)))]
async fn process_outgoing_channel<S: IViews>(
    pool: &S,
    recipient_addr: Felt,
    mut cursor: ChannelCursor,
    budget: &IoBudget,
) -> Result<OutgoingChannelResult, DiscoveryError> {
    let channel_key = cursor.channel_key.ok_or_else(|| {
        DiscoveryError::InvalidCursor("channel_key is required for outgoing channel".into())
    })?;

    discover_subchannels_paginated(pool, channel_key, &mut cursor, budget).await?;

    // Extract incomplete subchannels for processing; complete ones stay
    // in the cursor. The client is responsible for pruning complete entries.
    let mut pending_futures: FuturesUnordered<_> = cursor
        .subchannels
        .extract_if(|_, sc| !sc.note_discovery_complete)
        .map(|(token, sc_cursor)| {
            process_outgoing_subchannel(pool, channel_key, token, sc_cursor, budget)
        })
        .collect();

    let mut subchannels: Vec<OutgoingSubchannel> = Vec::new();
    while let Some(result) = pending_futures.next().await {
        let result = result?;
        subchannels.push(OutgoingSubchannel {
            recipient_addr,
            token: result.token,
            last_note_index: result.last_note_index,
        });
        cursor.subchannels.insert(result.token, result.cursor);
    }

    Ok(OutgoingChannelResult {
        recipient_addr,
        subchannels,
        cursor,
    })
}

/// Processes a single outgoing subchannel: probes for last note index.
#[instrument(skip_all, fields(token = felt_hex(&token)))]
async fn process_outgoing_subchannel<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    mut cursor: SubchannelCursor,
    budget: &IoBudget,
) -> Result<OutgoingSubchannelResult, DiscoveryError> {
    if cursor.note_discovery_complete {
        return Ok(OutgoingSubchannelResult {
            token,
            last_note_index: cursor.last_note_index,
            cursor,
        });
    }

    let (last_index, has_more) =
        find_last_note_index_paginated(pool, channel_key, token, &mut cursor, budget).await?;

    cursor.note_discovery_complete = !has_more;

    Ok(OutgoingSubchannelResult {
        token,
        last_note_index: last_index,
        cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::COST_OUTGOING_CHANNEL_INFO;
    use crate::storage_backend::MockBackend;
    use crate::test_fixtures::load_devnet_fixture;

    /// Full discovery with generous budget. Alice has 2 outgoing channels
    /// (self + Bob), each with 1 STRK subchannel, each with last_note_index=0.
    #[tokio::test]
    async fn test_sync_outgoing_state_full_discovery() {
        let f = load_devnet_fixture();
        let backend = MockBackend::new(f.slots);
        let decryption_key = SecretFelt::new(f.constants.alice_decryption_key);

        let cursor = DiscoveryCursor::default();
        let budget = IoBudget::new(100);

        let out = sync_outgoing_state(
            &backend,
            f.constants.alice_address,
            &decryption_key,
            cursor,
            &budget,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            out.channels.len(),
            2,
            "Alice has 2 outgoing channels (self + Bob)"
        );
        assert_eq!(
            out.subchannels.len(),
            2,
            "2 subchannels (one STRK per channel)"
        );

        // Verify channel info
        let alice_ch = out
            .channels
            .iter()
            .find(|c| c.recipient_addr == f.constants.alice_address)
            .expect("Alice self-channel");
        assert_ne!(alice_ch.channel_key, Felt::ZERO);

        let bob_ch = out
            .channels
            .iter()
            .find(|c| c.recipient_addr == f.constants.bob_address)
            .expect("Bob channel");
        assert_ne!(bob_ch.channel_key, Felt::ZERO);

        // Verify subchannel info
        for sc in &out.subchannels {
            assert_eq!(sc.token, f.constants.strk_token);
            assert_eq!(sc.last_note_index, Some(0));
        }

        // All channels are on-chain (not precomputed)
        assert!(
            out.channels.iter().all(|c| !c.precomputed),
            "all channels should be on-chain"
        );
        assert!(out.cursor.is_complete(), "all discovery complete");
    }

    /// Pagination test: first call discovers channels only (budget=9 covers
    /// 3 × COST_OUTGOING_CHANNEL_INFO = ch0 + ch1 + sentinel), then second
    /// call with generous budget finishes subchannel + note discovery.
    #[tokio::test]
    async fn test_sync_outgoing_state_pagination() {
        let f = load_devnet_fixture();
        let backend = MockBackend::new(f.slots);
        let decryption_key = SecretFelt::new(f.constants.alice_decryption_key);

        // Step 1: budget = 3 × COST_OUTGOING_CHANNEL_INFO = 9
        // Discovers 2 channels + sentinel. No budget left for subchannels.
        let cursor = DiscoveryCursor::default();
        let budget = IoBudget::new(3 * COST_OUTGOING_CHANNEL_INFO);

        let out = sync_outgoing_state(
            &backend,
            f.constants.alice_address,
            &decryption_key,
            cursor,
            &budget,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            out.cursor.channels.len(),
            2,
            "step 1: 2 channels registered in cursor"
        );
        assert!(
            out.cursor.channel_discovery_complete,
            "step 1: channel discovery complete (sentinel found)"
        );

        // Step 1 should have emitted the channels (discovered in this call).
        assert_eq!(
            out.channels.len(),
            2,
            "step 1: both channels emitted on discovery"
        );

        // Step 2: generous budget. Channel discovery skipped (cursor.channels
        // non-empty). Finishes subchannel + note discovery for both channels.
        let budget = IoBudget::new(100);
        let out2 = sync_outgoing_state(
            &backend,
            f.constants.alice_address,
            &decryption_key,
            out.cursor,
            &budget,
            None,
        )
        .await
        .unwrap();

        // Channels are not re-emitted — they were returned in step 1.
        assert_eq!(
            out2.channels.len(),
            0,
            "step 2: no new channels (already discovered in step 1)"
        );
        assert_eq!(out2.subchannels.len(), 2, "step 2: both subchannels done");
        assert!(out2.cursor.is_complete(), "step 2: all discovery complete");
        for sc in &out2.subchannels {
            assert_eq!(sc.last_note_index, Some(0));
        }
    }

    /// Recipients filter: requesting only Bob filters out Alice's self-channel.
    #[tokio::test]
    async fn test_sync_outgoing_state_recipients_filter() {
        let f = load_devnet_fixture();
        let backend = MockBackend::new(f.slots);
        let decryption_key = SecretFelt::new(f.constants.alice_decryption_key);

        let recipients = HashSet::from([f.constants.bob_address]);

        let out = sync_outgoing_state(
            &backend,
            f.constants.alice_address,
            &decryption_key,
            DiscoveryCursor::default(),
            &IoBudget::new(100),
            Some(&recipients),
        )
        .await
        .unwrap();

        assert_eq!(out.channels.len(), 1, "only Bob's channel returned");
        assert_eq!(out.channels[0].recipient_addr, f.constants.bob_address);
        assert_eq!(out.subchannels.len(), 1);
        assert_eq!(out.subchannels[0].recipient_addr, f.constants.bob_address);
    }

    /// Regression: complete channels must survive in the cursor when
    /// incomplete channels are processed in the same call. This happens
    /// when the client passes a cursor with a mix of complete and
    /// incomplete channel entries.
    #[tokio::test]
    async fn test_complete_channels_preserved_during_processing() {
        use std::collections::HashMap;

        use crate::discovery::ChannelCursor;

        let f = load_devnet_fixture();
        let backend = MockBackend::new(f.slots);
        let decryption_key = SecretFelt::new(f.constants.alice_decryption_key);

        // First, do a full discovery to get real channel keys.
        let full = sync_outgoing_state(
            &backend,
            f.constants.alice_address,
            &decryption_key,
            DiscoveryCursor::default(),
            &IoBudget::new(1000),
            None,
        )
        .await
        .unwrap();
        assert!(full.cursor.is_complete());

        // Build a cursor where Alice's self-channel is complete but Bob's
        // channel is incomplete (subchannel discovery not started).
        let alice_cursor = full
            .cursor
            .channels
            .get(&f.constants.alice_address)
            .unwrap()
            .clone();
        assert!(alice_cursor.is_complete(), "precondition: Alice complete");

        let bob_key = full
            .cursor
            .channels
            .get(&f.constants.bob_address)
            .unwrap()
            .channel_key;
        let bob_incomplete = ChannelCursor {
            channel_key: bob_key,
            subchannel_discovery_complete: false,
            last_subchannel_index: None,
            subchannels: HashMap::new(),
        };

        let cursor = DiscoveryCursor {
            channel_discovery_complete: true,
            last_channel_index: Some(1),
            channels: HashMap::from([
                (f.constants.alice_address, alice_cursor),
                (f.constants.bob_address, bob_incomplete),
            ]),
            ..Default::default()
        };

        // Process: only Bob's channel has pending work, but Alice's must
        // survive in the returned cursor.
        let out = sync_outgoing_state(
            &backend,
            f.constants.alice_address,
            &decryption_key,
            cursor,
            &IoBudget::new(1000),
            None,
        )
        .await
        .unwrap();

        assert!(
            out.cursor.channels.contains_key(&f.constants.alice_address),
            "complete Alice channel must survive in cursor"
        );
        assert!(
            out.cursor.channels.contains_key(&f.constants.bob_address),
            "processed Bob channel must be in cursor"
        );
        assert!(out.cursor.is_complete(), "all discovery complete");
    }
}
