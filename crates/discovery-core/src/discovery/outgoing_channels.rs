//! Outgoing channel discovery.
//!
//! This module provides functionality to discover outgoing channels
//! for a given sender. Outgoing channels store encrypted recipient addresses
//! that only the sender can decrypt using their viewing key.

use starknet_types_core::felt::Felt;

use super::cursor::DiscoveryCursor;
use super::DiscoveryError;
use super::COST_OUTGOING_CHANNEL_INFO;
use crate::io_budget::IoBudget;
use crate::privacy_pool::decryption::decrypt_outgoing_recipient_addr;
use crate::privacy_pool::hashes::{compute_channel_key, compute_outgoing_channel_id};
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// A discovered and decrypted outgoing channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingChannel {
    /// The index of this outgoing channel.
    pub index: u64,
    /// The decrypted recipient address.
    pub recipient_addr: Felt,
    /// The channel key derived from sender + recipient identity.
    pub channel_key: Felt,
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

/// Discovers and decrypts outgoing channels for a given sender.
///
/// # Algorithm
///
/// For each outgoing channel index starting from `start_index`:
/// 1. Compute `outgoing_channel_id = hash(OUTGOING_CHANNEL_ID_TAG, sender_addr, viewing_key, index, 0)`
/// 2. Fetch `EncOutgoingChannelInfo { salt, enc_recipient_addr }` from storage
/// 3. If `salt == 0`, stop (sentinel - no more outgoing channels)
/// 4. Decrypt: `recipient_addr = enc_recipient_addr - hash(ENC_RECIPIENT_ADDR_TAG, sender_addr, viewing_key, index, 0, salt)`
///
/// # Arguments
///
/// * `privacy_pool` - Storage backend implementing the IViews trait.
/// * `sender_addr` - The sender's address.
/// * `viewing_key` - The sender's private viewing key.
/// * `start_index` - Starting index (inclusive). For incremental discovery, pass
///   `last_index + 1` from previous result.
/// * `budget` - I/O budget to limit storage operations.
pub async fn discover_outgoing_channels<PrivacyPool: IViews>(
    privacy_pool: &PrivacyPool,
    sender_addr: Felt,
    viewing_key: &SecretFelt,
    start_index: u64,
    budget: &IoBudget,
) -> Result<OutgoingChannelDiscoveryResult, DiscoveryError> {
    let mut channels = Vec::new();
    let mut index = start_index;
    let mut out_of_budget = false;

    loop {
        if !budget.consume(COST_OUTGOING_CHANNEL_INFO) {
            out_of_budget = true;
            break;
        }

        let outgoing_channel_id = compute_outgoing_channel_id(sender_addr, viewing_key, index);
        let encrypted = privacy_pool
            .get_outgoing_channel_info(outgoing_channel_id)
            .await?;

        // Sentinel: salt == 0 means no more outgoing channels
        if encrypted.salt == Felt::ZERO {
            break;
        }

        let recipient_addr =
            decrypt_outgoing_recipient_addr(&encrypted, sender_addr, viewing_key, index);
        let recipient_public_key = privacy_pool.get_public_key(recipient_addr).await?;
        let channel_key = compute_channel_key(
            sender_addr,
            viewing_key,
            recipient_addr,
            recipient_public_key,
        );

        channels.push(OutgoingChannel {
            index,
            recipient_addr,
            channel_key,
        });
        index += 1;
    }

    let last_index = channels.last().map(|c| c.index);

    Ok(OutgoingChannelDiscoveryResult {
        channels,
        last_index,
        has_more: out_of_budget,
    })
}

/// Discovers outgoing channels with cursor-based pagination.
///
/// Manages resume state across calls. If `cursor.skip_channel_discovery` is
/// set, returns immediately without consuming budget — use this to skip
/// channel discovery and only process specific recipients/tokens already in
/// cursor.
///
/// Returns discovered channels.
pub async fn discover_outgoing_channels_paginated<S: IViews>(
    pool: &S,
    sender_addr: Felt,
    viewing_key: &SecretFelt,
    cursor: &mut DiscoveryCursor,
    budget: &IoBudget,
) -> Result<Vec<OutgoingChannel>, DiscoveryError> {
    if cursor.skip_channel_discovery {
        return Ok(Vec::new());
    }

    let start_index = cursor.last_channel_index.map_or(0, |i| i + 1);
    let result =
        discover_outgoing_channels(pool, sender_addr, viewing_key, start_index, budget).await?;

    // Register discovered channels in cursor with their channel_key.
    for ch in &result.channels {
        let entry = cursor.channels.entry(ch.recipient_addr).or_insert_with(|| {
            super::cursor::ChannelCursor {
                channel_key: None,
                total_n_subchannels: None,
                last_subchannel_index: None,
                subchannels: std::collections::HashMap::new(),
            }
        });
        entry.channel_key = Some(ch.channel_key);
    }

    cursor.last_channel_index = result.last_index.or(cursor.last_channel_index);
    // Stop discovering once sentinel is found.
    if !result.has_more {
        cursor.skip_channel_discovery = true;
    }

    Ok(result.channels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_backend::MockBackend;
    use crate::test_fixtures::load_devnet_fixture;

    #[tokio::test]
    async fn test_discover_no_outgoing_channels() {
        let backend = MockBackend::empty();
        let sender_addr = Felt::from_hex_unchecked("0x12345");
        let viewing_key = SecretFelt::new(Felt::from_hex_unchecked("0x67890"));
        let budget = IoBudget::new(100);

        let result = discover_outgoing_channels(&backend, sender_addr, &viewing_key, 0, &budget)
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

        let viewing_key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let budget = IoBudget::new(100);

        let result = discover_outgoing_channels(
            &backend,
            fixture.constants.alice_address,
            &viewing_key,
            0,
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

        assert_eq!(result.channels[0].index, 0);
        assert_eq!(
            result.channels[0].recipient_addr, fixture.constants.alice_address,
            "First outgoing channel should point to Alice (self-channel)"
        );

        assert_eq!(result.channels[1].index, 1);
        assert_eq!(
            result.channels[1].recipient_addr, fixture.constants.bob_address,
            "Second outgoing channel should point to Bob"
        );
    }

    #[tokio::test]
    async fn test_paginated_full_discovery() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let viewing_key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let mut cursor = DiscoveryCursor::default();
        let budget = IoBudget::new(100);

        let channels = discover_outgoing_channels_paginated(
            &backend,
            fixture.constants.alice_address,
            &viewing_key,
            &mut cursor,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(channels.len(), 2);
        assert_eq!(cursor.last_channel_index, Some(1));
        assert!(cursor.skip_channel_discovery, "discovery complete");

        // Second call should return empty (already complete)
        let channels2 = discover_outgoing_channels_paginated(
            &backend,
            fixture.constants.alice_address,
            &viewing_key,
            &mut cursor,
            &budget,
        )
        .await
        .unwrap();

        assert!(channels2.is_empty());
    }

    #[tokio::test]
    async fn test_paginated_budget_limited() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let viewing_key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let mut cursor = DiscoveryCursor::default();

        // Budget for 1 channel (COST_OUTGOING_CHANNEL_INFO = 3)
        let budget = IoBudget::new(COST_OUTGOING_CHANNEL_INFO);
        let channels = discover_outgoing_channels_paginated(
            &backend,
            fixture.constants.alice_address,
            &viewing_key,
            &mut cursor,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(channels.len(), 1);
        assert_eq!(cursor.last_channel_index, Some(0));
        assert!(!cursor.skip_channel_discovery, "discovery not complete yet");

        // Resume with more budget
        let budget = IoBudget::new(100);
        let channels2 = discover_outgoing_channels_paginated(
            &backend,
            fixture.constants.alice_address,
            &viewing_key,
            &mut cursor,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(channels2.len(), 1, "second channel discovered");
        assert_eq!(cursor.last_channel_index, Some(1));
        assert!(cursor.skip_channel_discovery, "discovery complete");
    }
}
