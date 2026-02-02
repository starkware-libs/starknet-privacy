//! Incoming channel discovery.
//!
//! This module provides functionality to discover and decrypt incoming channels
//! for a recipient address.

use starknet_types_core::felt::Felt;

use super::DiscoveryError;
use crate::decryption::decrypt_channel_info;
use crate::io_budget::{IoBudget, COST_CHANNEL_INFO, COST_NUM_CHANNELS};
use crate::storage::IViews;
use crate::types::ChannelInfo;

/// A discovered and decrypted incoming channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingChannel {
    /// The index of this channel in the recipient's channel list.
    pub index: u64,
    /// The decrypted channel info.
    pub info: ChannelInfo,
}

/// Result of channel discovery operation.
#[derive(Debug, Clone)]
pub struct DiscoveryResult {
    /// List of discovered and decrypted incoming channels.
    pub channels: Vec<IncomingChannel>,
    /// Next index to scan for incremental discovery.
    /// Use this as `start_index` for the next discovery call.
    pub total_n_channels: u64,
    /// Whether there may be more channels to discover.
    /// `true` if stopped due to budget exhaustion, `false` if all channels were scanned.
    pub has_more: bool,
}

/// Discovers and decrypts incoming channels for a recipient.
///
/// # Arguments
///
/// * `privacy_pool` - Storage backend implementing the IViews trait.
/// * `recipient_addr` - The recipient's account address.
/// * `private_key` - The private viewing key of that account.
/// * `start_index` - Starting index (inclusive). Pass 0 to discover all channels.
///   Use `total_n_channels` from a previous result to continue incremental discovery.
/// * `budget` - I/O budget to limit storage operations.
///
/// # Returns
///
/// A `DiscoveryResult` containing all discovered channels and metadata for
/// incremental discovery.
///
/// # Security
///
/// The caller should zero the `private_key` after use by calling
/// `private_key.zeroize()` (see `crate::channel_info::Zeroize`).
pub async fn discover_incoming_channels<PrivacyPool: IViews>(
    privacy_pool: &PrivacyPool,
    recipient_addr: Felt,
    private_key: &Felt,
    start_index: u64,
    budget: &IoBudget,
) -> Result<DiscoveryResult, DiscoveryError> {
    // Consume budget for get_num_of_channels
    if budget.consume(COST_NUM_CHANNELS).is_none() {
        return Ok(DiscoveryResult {
            channels: vec![],
            total_n_channels: start_index,
            has_more: true,
        });
    }

    // Get total number of channels
    let actual_total = privacy_pool.get_num_of_channels(recipient_addr).await?;

    // If no new channels, return early
    if start_index >= actual_total {
        return Ok(DiscoveryResult {
            channels: vec![],
            total_n_channels: actual_total,
            has_more: false,
        });
    }

    // Discover and decrypt each channel
    let capacity = usize::try_from(actual_total.saturating_sub(start_index))
        .expect("channel count exceeds usize");
    let mut channels = Vec::with_capacity(capacity);
    let mut index = start_index;
    let mut out_of_budget = false;

    loop {
        // Check if we've processed all channels
        if index >= actual_total {
            break;
        }

        // Consume budget for get_channel_info
        if budget.consume(COST_CHANNEL_INFO).is_none() {
            out_of_budget = true;
            break;
        }

        let encrypted = privacy_pool.get_channel_info(recipient_addr, index).await?;

        let info = decrypt_channel_info(&encrypted, private_key)
            .map_err(|source| DiscoveryError::Decryption { index, source })?;

        channels.push(IncomingChannel { index, info });
        index += 1;
    }

    Ok(DiscoveryResult {
        channels,
        total_n_channels: index,
        has_more: out_of_budget,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock_backend::MockBackend;
    use crate::test_fixtures::load_devnet_fixture;

    #[tokio::test]
    async fn test_discover_no_channels() {
        let backend = MockBackend::empty();
        let recipient = Felt::from_hex_unchecked("0x123");
        let key = Felt::from(1u64);
        let budget = IoBudget::new(100);

        // Test with 0 (start from beginning)
        let result1 = discover_incoming_channels(&backend, recipient, &key, 0, &budget)
            .await
            .unwrap();

        // Test with 5 (arbitrary index beyond total)
        let result2 = discover_incoming_channels(&backend, recipient, &key, 5, &budget)
            .await
            .unwrap();

        // Both should return empty with no more to discover
        for result in [&result1, &result2] {
            assert_eq!(result.channels.len(), 0);
            assert_eq!(result.total_n_channels, 0);
            assert!(!result.has_more);
        }
    }

    #[tokio::test]
    async fn test_discover_alice_self_channel() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);
        let budget = IoBudget::new(100);

        let result = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
            0,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 1, "Alice should have 1 channel");
        assert_eq!(result.total_n_channels, 1);
        assert!(!result.has_more);
        assert_eq!(result.channels[0].index, 0);
        // Alice's channel is a self-channel (change from deposit+transfer)
        assert_eq!(
            result.channels[0].info.sender_addr,
            fixture.constants.alice_address
        );
    }

    #[tokio::test]
    async fn test_discover_bob_incoming_channel() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);
        let budget = IoBudget::new(100);

        let result = discover_incoming_channels(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
            0,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 1, "Bob should have 1 channel");
        assert_eq!(result.total_n_channels, 1);
        assert!(!result.has_more);
        assert_eq!(result.channels[0].index, 0);
        // Bob's channel is from Alice (transfer)
        assert_eq!(
            result.channels[0].info.sender_addr,
            fixture.constants.alice_address
        );
    }

    #[tokio::test]
    async fn test_discover_incremental() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);
        let budget = IoBudget::new(100);

        // First discovery - get all channels
        let result1 = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
            0,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result1.channels.len(), 1);
        assert_eq!(result1.total_n_channels, 1);
        assert!(!result1.has_more);

        // Incremental discovery using total_n_channels as start_index
        // Should return empty since we've discovered all channels
        let result2 = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
            result1.total_n_channels, // Start from 1, but only 1 channel exists
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result2.channels.len(), 0);
        assert_eq!(result2.total_n_channels, 1); // Total unchanged
        assert!(!result2.has_more);
    }

    #[tokio::test]
    async fn test_discover_out_of_budget() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // Budget exhausted before starting
        let budget = IoBudget::new(0);
        let result = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
            0,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 0);
        assert_eq!(result.total_n_channels, 0); // Returns start_index when budget exhausted
        assert!(result.has_more);

        // Budget allows get_num_of_channels but not get_channel_info
        // COST_NUM_CHANNELS = 1, COST_CHANNEL_INFO = 3
        let budget = IoBudget::new(2);
        let result = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
            0,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 0);
        assert_eq!(result.total_n_channels, 0); // Returns start_index (0) when no channels fetched
        assert!(result.has_more);
    }
}
