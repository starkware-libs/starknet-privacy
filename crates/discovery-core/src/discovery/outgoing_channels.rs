//! Outgoing channel discovery.
//!
//! This module provides functionality to discover outgoing channels
//! for a given sender. Outgoing channels store encrypted recipient addresses
//! that only the sender can decrypt using their viewing key.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

use tracing::{debug, trace};

use crate::discovery::cursor::{ChannelCursor, DiscoveryCursor};
use crate::discovery::{DiscoveryError, COST_OUTGOING_CHANNEL_INFO, COST_PUBLIC_KEY};
use crate::io_budget::IoBudget;
use crate::privacy_pool::decryption::decrypt_outgoing_recipient_addr;
use crate::privacy_pool::felt_hex;
use crate::privacy_pool::hashes::{compute_channel_key, compute_outgoing_channel_id};
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// A discovered and decrypted outgoing channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutgoingChannel {
    /// The decrypted recipient address.
    pub recipient_addr: Felt,
    /// The recipient's public viewing key.
    pub recipient_public_key: Felt,
    /// The channel key derived from sender + recipient identity.
    pub channel_key: Felt,
    /// `true` when this channel does not yet exist on-chain and was computed
    /// from a requested recipient's public key (a "future" channel).
    #[serde(default)]
    pub precomputed: bool,
}

impl OutgoingChannel {
    /// Builds an `OutgoingChannel` by computing the channel key from identity parameters.
    fn new(
        sender_addr: Felt,
        decryption_key: &SecretFelt,
        recipient_addr: Felt,
        recipient_public_key: Felt,
        precomputed: bool,
    ) -> Self {
        let channel_key = compute_channel_key(
            sender_addr,
            decryption_key,
            recipient_addr,
            recipient_public_key,
        );
        Self {
            recipient_addr,
            recipient_public_key,
            channel_key,
            precomputed,
        }
    }
}

/// Result of outgoing channel discovery operation.
#[derive(Debug, Clone)]
pub struct OutgoingChannelDiscoveryResult {
    /// List of discovered and decrypted outgoing channels.
    pub channels: Vec<OutgoingChannel>,
    /// Index of the last discovered channel, or `None` if no channels were discovered.
    pub last_index: Option<u64>,
    /// Whether there may be more channels to discover.
    /// `true` if stopped due to budget exhaustion, `false` if sentinel was found.
    pub has_more: bool,
}

/// Discovers outgoing channels with cursor-based pagination.
///
/// Manages resume state across calls. If `cursor.channel_discovery_complete` is
/// set (by the service once the sentinel channel is reached), returns
/// immediately without consuming budget.
///
/// `max_cursor_channels` caps how many channels live in the cursor at once.
///
/// When `recipients` is provided, only channels matching the filter are
/// registered in the cursor and included in the returned vec.
pub async fn discover_outgoing_channels_paginated<S: IViews>(
    pool: &S,
    sender_addr: Felt,
    decryption_key: &SecretFelt,
    cursor: &mut DiscoveryCursor,
    max_cursor_channels: usize,
    budget: &IoBudget,
    recipients: Option<&HashSet<Felt>>,
) -> Result<Vec<OutgoingChannel>, DiscoveryError> {
    if cursor.channel_discovery_complete {
        return Ok(Vec::new());
    }

    // Gate on cursor capacity — don't discover new channels if cursor is full.
    let cursor_slots = max_cursor_channels.saturating_sub(cursor.channels.len());
    if cursor_slots == 0 {
        return Ok(Vec::new());
    }

    let start_index = cursor.last_channel_index.map_or(0, |i| i + 1);
    let mut result = discover_outgoing_channels(
        pool,
        sender_addr,
        decryption_key,
        start_index,
        cursor_slots,
        budget,
    )
    .await?;

    // Filter channels by recipients if provided.
    if let Some(filter) = recipients {
        result
            .channels
            .retain(|channel| filter.contains(&channel.recipient_addr));
    }

    // Register discovered channels in cursor.
    for channel in result.channels.iter() {
        cursor
            .channels
            .entry(channel.recipient_addr)
            .or_insert_with(|| ChannelCursor {
                channel_key: Some(channel.channel_key),
                subchannel_discovery_complete: false,
                last_subchannel_index: None,
                subchannels: HashMap::new(),
            });
    }

    cursor.last_channel_index = result.last_index.or(cursor.last_channel_index);
    // Stop discovering once sentinel is found.
    if !result.has_more {
        cursor.channel_discovery_complete = true;
    }

    Ok(result.channels)
}

/// Discovers and decrypts outgoing channels for a given sender.
///
/// # Algorithm
///
/// For each outgoing channel index starting from `start_index`:
/// 1. Compute `outgoing_channel_id = hash(OUTGOING_CHANNEL_ID_TAG, sender_addr, decryption_key, index, 0)`
/// 2. Fetch `EncOutgoingChannelInfo { salt, enc_recipient_addr }` from storage
/// 3. If `salt == 0`, stop (sentinel - no more outgoing channels)
/// 4. Decrypt: `recipient_addr = enc_recipient_addr - hash(ENC_RECIPIENT_ADDR_TAG, sender_addr, decryption_key, index, 0, salt)`
///
/// # Arguments
///
/// * `privacy_pool` - Storage backend implementing the IViews trait.
/// * `sender_addr` - The sender's address.
/// * `decryption_key` - The sender's private viewing key.
/// * `start_index` - Starting index (inclusive). For incremental discovery, pass
///   `last_index + 1` from previous result.
/// * `max_channels` - Maximum number of channels to discover before stopping.
///   Use `usize::MAX` for no cap.
/// * `budget` - I/O budget to limit storage operations.
pub async fn discover_outgoing_channels<PrivacyPool: IViews>(
    privacy_pool: &PrivacyPool,
    sender_addr: Felt,
    decryption_key: &SecretFelt,
    start_index: u64,
    max_channels: usize,
    budget: &IoBudget,
) -> Result<OutgoingChannelDiscoveryResult, DiscoveryError> {
    let mut channels = Vec::new();
    let mut index = start_index;
    let mut has_more = false;
    let mut last_index: Option<u64> = None;

    loop {
        if channels.len() >= max_channels {
            has_more = true;
            break;
        }

        if !budget.consume(COST_OUTGOING_CHANNEL_INFO) {
            has_more = true;
            break;
        }

        let outgoing_channel_id = compute_outgoing_channel_id(sender_addr, decryption_key, index);
        let encrypted = privacy_pool
            .get_outgoing_channel_info(outgoing_channel_id)
            .await?;

        // Sentinel: salt == 0 means no more outgoing channels
        if encrypted.salt == Felt::ZERO {
            break;
        }

        let recipient_addr =
            decrypt_outgoing_recipient_addr(&encrypted, sender_addr, decryption_key, index);
        let recipient_public_key = privacy_pool.get_public_key(recipient_addr).await?;

        trace!(
            index,
            recipient = felt_hex(&recipient_addr),
            "outgoing channel found"
        );
        channels.push(OutgoingChannel::new(
            sender_addr,
            decryption_key,
            recipient_addr,
            recipient_public_key,
            false,
        ));
        last_index = Some(index);
        index += 1;
    }

    debug!(
        sender = felt_hex(&sender_addr),
        start_index,
        channels = channels.len(),
        last_index = ?last_index,
        has_more,
        "discover_outgoing_channels done"
    );

    Ok(OutgoingChannelDiscoveryResult {
        channels,
        last_index,
        has_more,
    })
}

/// Precomputes outgoing channels for recipients that have no on-chain channel.
///
/// Fetches public keys in batch for the given `recipient_addrs`, skips
/// unregistered recipients (pk == 0), and returns `OutgoingChannel` entries
/// with `precomputed: true`.
pub async fn precompute_channels<S: IViews>(
    pool: &S,
    sender_addr: Felt,
    decryption_key: &SecretFelt,
    recipient_addrs: &[Felt],
    budget: &IoBudget,
) -> Result<Vec<OutgoingChannel>, DiscoveryError> {
    if recipient_addrs.is_empty() {
        return Ok(Vec::new());
    }
    // TODO: budget.consume proceeds even when over budget (capped by max
    // recipients validation). Consider paginating if the recipient list grows.
    budget.consume(recipient_addrs.len() * COST_PUBLIC_KEY);
    let pks = pool.get_public_keys_batch(recipient_addrs).await?;
    Ok(recipient_addrs
        .iter()
        .copied()
        .zip(pks)
        .filter(|(_, pk)| *pk != Felt::ZERO)
        .map(|(addr, pk)| OutgoingChannel::new(sender_addr, decryption_key, addr, pk, true))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_backend::MockBackend;
    use crate::test_fixtures::{insert_dummy_channel_cursor, load_devnet_fixture};

    #[tokio::test]
    async fn test_discover_no_outgoing_channels() {
        let backend = MockBackend::empty();
        let sender_addr = Felt::from_hex_unchecked("0x12345");
        let decryption_key = SecretFelt::new(Felt::from_hex_unchecked("0x67890"));
        let budget = IoBudget::new(100);

        let result = discover_outgoing_channels(
            &backend,
            sender_addr,
            &decryption_key,
            0,
            usize::MAX,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 0);
        assert_eq!(result.last_index, None);
        assert!(!result.has_more);
    }

    #[tokio::test]
    async fn test_discover_alice_outgoing_channels() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let decryption_key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let budget = IoBudget::new(100);

        let result = discover_outgoing_channels(
            &backend,
            fixture.constants.alice_address,
            &decryption_key,
            0,
            usize::MAX,
            &budget,
        )
        .await
        .unwrap();

        // Alice deposited 100 STRK (self-channel) + transferred 50 to Bob,
        // so she has 2 outgoing channels: one to herself and one to Bob.
        assert_eq!(
            result.channels.len(),
            2,
            "Alice should have 2 outgoing channels (self + Bob)"
        );
        assert_eq!(result.last_index, Some(1));
        assert!(!result.has_more);

        assert_eq!(
            result.channels[0].recipient_addr, fixture.constants.alice_address,
            "First outgoing channel should point to Alice (self-channel)"
        );

        assert_eq!(
            result.channels[1].recipient_addr, fixture.constants.bob_address,
            "Second outgoing channel should point to Bob"
        );
    }

    #[tokio::test]
    async fn test_paginated_full_discovery() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let decryption_key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let mut cursor = DiscoveryCursor::default();
        let budget = IoBudget::new(100);

        let channels = discover_outgoing_channels_paginated(
            &backend,
            fixture.constants.alice_address,
            &decryption_key,
            &mut cursor,
            usize::MAX,
            &budget,
            None,
        )
        .await
        .unwrap();

        assert_eq!(channels.len(), 2);
        assert_eq!(cursor.last_channel_index, Some(1));
        assert!(cursor.channel_discovery_complete, "discovery complete");

        // Second call should return empty (already complete)
        let channels2 = discover_outgoing_channels_paginated(
            &backend,
            fixture.constants.alice_address,
            &decryption_key,
            &mut cursor,
            usize::MAX,
            &budget,
            None,
        )
        .await
        .unwrap();

        assert!(channels2.is_empty());
    }

    #[tokio::test]
    async fn test_paginated_budget_limited() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let decryption_key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let mut cursor = DiscoveryCursor::default();

        // Budget for 1 channel (COST_OUTGOING_CHANNEL_INFO = 3)
        let budget = IoBudget::new(COST_OUTGOING_CHANNEL_INFO);
        let channels = discover_outgoing_channels_paginated(
            &backend,
            fixture.constants.alice_address,
            &decryption_key,
            &mut cursor,
            usize::MAX,
            &budget,
            None,
        )
        .await
        .unwrap();

        assert_eq!(channels.len(), 1);
        assert_eq!(cursor.last_channel_index, Some(0));
        assert!(
            !cursor.channel_discovery_complete,
            "discovery not complete yet"
        );

        // Resume with more budget
        let budget = IoBudget::new(100);
        let channels2 = discover_outgoing_channels_paginated(
            &backend,
            fixture.constants.alice_address,
            &decryption_key,
            &mut cursor,
            usize::MAX,
            &budget,
            None,
        )
        .await
        .unwrap();

        assert_eq!(channels2.len(), 1, "second channel discovered");
        assert_eq!(cursor.last_channel_index, Some(1));
        assert!(cursor.channel_discovery_complete, "discovery complete");
    }

    #[tokio::test]
    async fn test_discover_max_channels_caps_discovery() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let decryption_key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let budget = IoBudget::new(100);

        // Alice has 2 outgoing channels; cap at 1.
        let result = discover_outgoing_channels(
            &backend,
            fixture.constants.alice_address,
            &decryption_key,
            0,
            1,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 1, "capped at max_channels = 1");
        assert_eq!(result.last_index, Some(0));
        assert!(result.has_more, "more channels remain");

        // Resume from index 1 with no cap — discovers second channel + hits sentinel.
        let result2 = discover_outgoing_channels(
            &backend,
            fixture.constants.alice_address,
            &decryption_key,
            1,
            usize::MAX,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result2.channels.len(), 1, "discovers remaining channel");
        assert_eq!(result2.last_index, Some(1));
        assert!(!result2.has_more, "sentinel reached");
    }

    #[tokio::test]
    async fn test_paginated_cursor_full_skips_discovery() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let mut cursor = DiscoveryCursor::default();
        let budget = IoBudget::new(100);
        let decryption_key = SecretFelt::new(fixture.constants.alice_viewing_key);

        // Pre-fill cursor to capacity (1 entry, max_cursor_channels = 1).
        insert_dummy_channel_cursor(&mut cursor);

        let channels = discover_outgoing_channels_paginated(
            &backend,
            fixture.constants.alice_address,
            &decryption_key,
            &mut cursor,
            1,
            &budget,
            None,
        )
        .await
        .unwrap();

        assert!(channels.is_empty(), "cursor full — no new discovery");
        assert!(
            !cursor.channel_discovery_complete,
            "should NOT mark complete when cursor is full"
        );
    }

    #[tokio::test]
    async fn test_paginated_cursor_partial_slots_caps_discovery() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let mut cursor = DiscoveryCursor::default();
        let budget = IoBudget::new(100);
        let decryption_key = SecretFelt::new(fixture.constants.alice_viewing_key);

        // 1 existing entry + max_cursor_channels = 2 → 1 slot available.
        insert_dummy_channel_cursor(&mut cursor);

        let channels = discover_outgoing_channels_paginated(
            &backend,
            fixture.constants.alice_address,
            &decryption_key,
            &mut cursor,
            2,
            &budget,
            None,
        )
        .await
        .unwrap();

        assert_eq!(channels.len(), 1, "discovers up to 1 new channel");
        // cursor now has 2 entries: the pre-filled one + the newly discovered one
        assert_eq!(cursor.channels.len(), 2);
    }
}
