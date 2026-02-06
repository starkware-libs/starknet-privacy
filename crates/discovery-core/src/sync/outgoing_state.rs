//! Outgoing sync orchestrator.
//!
//! Composes paginated outgoing channel, subchannel, and note-index discovery
//! into a single [`sync_outgoing_state`] call that advances a [`DiscoveryCursor`].
//!
//! Channel and subchannel processing is concurrent via [`FuturesUnordered`].

use std::collections::HashMap;

use futures::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

use crate::discovery::cursor::{ChannelCursor, DiscoveryCursor, SubchannelCursor};
use crate::discovery::last_note_index::find_last_note_index_paginated;
use crate::discovery::outgoing_channels::discover_outgoing_channels_paginated;
use crate::discovery::subchannels::discover_subchannels_paginated;
use crate::discovery::DiscoveryError;
use crate::io_budget::IoBudget;
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// Output from a single outgoing discovery run.
#[derive(Debug, Clone, Serialize)]
pub struct OutgoingDiscoveryOutput {
    /// Discovered data per channel, keyed by recipient address.
    pub channels: HashMap<Felt, OutgoingChannelOutput>,
    /// Updated cursor for the next run.
    pub cursor: DiscoveryCursor,
}

/// Discovered data for a single outgoing channel within a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutgoingChannelOutput {
    /// The channel key for this outgoing channel.
    pub channel_key: Felt,
    /// Last note index per subchannel, keyed by token address.
    pub subchannels: HashMap<Felt, Option<u64>>,
}

/// Result of processing a single outgoing channel (internal).
struct OutgoingChannelResult {
    recipient_addr: Felt,
    output: OutgoingChannelOutput,
    /// `None` means fully discovered — prune from cursor.
    cursor: Option<ChannelCursor>,
}

/// Result of processing a single outgoing subchannel (internal).
struct OutgoingSubchannelResult {
    token: Felt,
    last_note_index: Option<u64>,
    /// `None` means fully discovered — prune from cursor.
    cursor: Option<SubchannelCursor>,
}

/// Runs hierarchical outgoing discovery: channels → subchannels → note index probing.
///
/// Each level uses cursor-based pagination. Fully-discovered subchannels
/// and channels are pruned from the cursor so subsequent calls skip them.
///
/// Channel and subchannel processing is concurrent via [`FuturesUnordered`].
pub async fn sync_outgoing_state<S: IViews>(
    pool: &S,
    sender_addr: Felt,
    viewing_key: &SecretFelt,
    mut cursor: DiscoveryCursor,
    budget: &IoBudget,
) -> Result<OutgoingDiscoveryOutput, DiscoveryError> {
    discover_outgoing_channels_paginated(pool, sender_addr, viewing_key, &mut cursor, budget)
        .await?;

    if cursor.channels.is_empty() {
        return Ok(OutgoingDiscoveryOutput {
            channels: HashMap::new(),
            cursor,
        });
    }

    let channels = std::mem::take(&mut cursor.channels);
    let mut futs: FuturesUnordered<_> = channels
        .into_iter()
        .map(|(recipient_addr, ch_cursor)| {
            process_outgoing_channel(pool, recipient_addr, ch_cursor, budget)
        })
        .collect();

    let mut channels_output: HashMap<Felt, OutgoingChannelOutput> = HashMap::new();
    while let Some(result) = futs.next().await {
        let result = result?;
        channels_output.insert(result.recipient_addr, result.output);
        if let Some(ch_cursor) = result.cursor {
            cursor.channels.insert(result.recipient_addr, ch_cursor);
        }
    }

    Ok(OutgoingDiscoveryOutput {
        channels: channels_output,
        cursor,
    })
}

/// Processes a single outgoing channel: discovers subchannels, then runs
/// note-index probing for each subchannel concurrently via [`FuturesUnordered`].
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

    let subchannels = std::mem::take(&mut cursor.subchannels);
    let mut futs: FuturesUnordered<_> = subchannels
        .into_iter()
        .map(|(token, sc_cursor)| {
            process_outgoing_subchannel(pool, channel_key, token, sc_cursor, budget)
        })
        .collect();

    let mut subchannel_results: HashMap<Felt, Option<u64>> = HashMap::new();
    while let Some(result) = futs.next().await {
        let result = result?;
        subchannel_results.insert(result.token, result.last_note_index);
        if let Some(sc_cursor) = result.cursor {
            cursor.subchannels.insert(result.token, sc_cursor);
        }
    }

    let fully_done = cursor.skip_subchannel_discovery && cursor.subchannels.is_empty();

    Ok(OutgoingChannelResult {
        recipient_addr,
        output: OutgoingChannelOutput {
            channel_key,
            subchannels: subchannel_results,
        },
        cursor: if fully_done { None } else { Some(cursor) },
    })
}

/// Processes a single outgoing subchannel: probes for last note index.
async fn process_outgoing_subchannel<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    mut cursor: SubchannelCursor,
    budget: &IoBudget,
) -> Result<OutgoingSubchannelResult, DiscoveryError> {
    let (last_index, has_more) =
        find_last_note_index_paginated(pool, channel_key, token, &mut cursor, budget).await?;

    Ok(OutgoingSubchannelResult {
        token,
        last_note_index: last_index,
        cursor: if has_more { Some(cursor) } else { None },
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
        let viewing_key = SecretFelt::new(f.constants.alice_viewing_key);

        let cursor = DiscoveryCursor::default();
        let budget = IoBudget::new(100);

        let out = sync_outgoing_state(
            &backend,
            f.constants.alice_address,
            &viewing_key,
            cursor,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(
            out.channels.len(),
            2,
            "Alice has 2 outgoing channels (self + Bob)"
        );

        // Self-channel (Alice → Alice)
        let alice_ch = &out.channels[&f.constants.alice_address];
        assert_eq!(
            alice_ch.subchannels[&f.constants.strk_token],
            Some(0),
            "Alice self-channel: STRK last_note_index=0"
        );

        // Bob channel (Alice → Bob)
        let bob_ch = &out.channels[&f.constants.bob_address];
        assert_eq!(
            bob_ch.subchannels[&f.constants.strk_token],
            Some(0),
            "Alice→Bob channel: STRK last_note_index=0"
        );

        assert!(
            out.cursor.channels.is_empty(),
            "all discovery complete — cursor empty"
        );
    }

    /// Pagination test: first call discovers channels only (budget=9 covers
    /// 3 × COST_OUTGOING_CHANNEL_INFO = ch0 + ch1 + sentinel), then second
    /// call with generous budget finishes subchannel + note discovery.
    #[tokio::test]
    async fn test_sync_outgoing_state_pagination() {
        let f = load_devnet_fixture();
        let backend = MockBackend::new(f.slots);
        let viewing_key = SecretFelt::new(f.constants.alice_viewing_key);

        // Step 1: budget = 3 × COST_OUTGOING_CHANNEL_INFO = 9
        // Discovers 2 channels + sentinel. No budget left for subchannels.
        let cursor = DiscoveryCursor::default();
        let budget = IoBudget::new(3 * COST_OUTGOING_CHANNEL_INFO);

        let out = sync_outgoing_state(
            &backend,
            f.constants.alice_address,
            &viewing_key,
            cursor,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(
            out.cursor.channels.len(),
            2,
            "step 1: 2 channels registered in cursor"
        );
        assert!(
            out.cursor.skip_channel_discovery,
            "step 1: channel discovery complete (sentinel found)"
        );

        // Step 2: generous budget to finish everything.
        let budget = IoBudget::new(100);
        let out = sync_outgoing_state(
            &backend,
            f.constants.alice_address,
            &viewing_key,
            out.cursor,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(out.channels.len(), 2, "step 2: both channels processed");
        assert!(
            out.cursor.channels.is_empty(),
            "step 2: all discovery complete"
        );
        assert_eq!(
            out.channels[&f.constants.alice_address].subchannels[&f.constants.strk_token],
            Some(0)
        );
        assert_eq!(
            out.channels[&f.constants.bob_address].subchannels[&f.constants.strk_token],
            Some(0)
        );
    }
}
