//! Incoming channel discovery.
//!
//! This module provides functionality to discover and decrypt incoming channels
//! for a recipient address.
//!
//! # Usage
//!
//! ```ignore
//! // First request: get count, then discover
//! let count = get_incoming_channel_count(&pool, recipient, &budget).await?;
//! let result = discover_incoming_channels(&pool, recipient, &key, 0, count, &budget).await?;
//!
//! // Subsequent requests: use cached count
//! let result = discover_incoming_channels(&pool, recipient, &key, start, cached_count, &budget).await?;
//! ```

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
    /// Index of the last discovered channel, or `None` if no channels were discovered.
    /// Use for cursor updates: `cursor.last_channel_index = result.last_index.or(cursor.last_channel_index)`.
    pub last_index: Option<u64>,
    /// Whether there may be more channels to discover.
    /// `true` if stopped due to budget exhaustion, `false` if all channels were scanned.
    pub has_more: bool,
}

/// Gets the total number of incoming channels for a recipient.
///
/// Call this once to get the count, then pass it to [`discover_incoming_channels`]
/// to avoid re-fetching on every call.
///
/// # Arguments
///
/// * `privacy_pool` - Storage backend implementing the IViews trait.
/// * `recipient_addr` - The recipient's account address.
/// * `budget` - I/O budget to limit storage operations.
///
/// # Returns
///
/// `Ok(Some(count))` - The total number of channels.
/// `Ok(None)` - Budget exhausted before fetching the count.
pub async fn get_incoming_channel_count<PrivacyPool: IViews>(
    privacy_pool: &PrivacyPool,
    recipient_addr: Felt,
    budget: &IoBudget,
) -> Result<Option<u64>, DiscoveryError> {
    if !budget.consume(COST_NUM_CHANNELS) {
        return Ok(None);
    }
    let count = privacy_pool.get_num_of_channels(recipient_addr).await?;
    Ok(Some(count))
}

/// Discovers and decrypts incoming channels for a recipient.
///
/// # Arguments
///
/// * `privacy_pool` - Storage backend implementing the IViews trait.
/// * `recipient_addr` - The recipient's account address.
/// * `private_key` - The private viewing key of that account.
/// * `start_index` - Starting index (inclusive). Pass 0 to discover all channels.
/// * `total_n_channels` - Total number of channels (from [`get_incoming_channel_count`]).
/// * `budget` - I/O budget to limit storage operations.
///
/// # Returns
///
/// A `DiscoveryResult` containing all discovered channels and whether more remain.
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
    total_n_channels: u64,
    budget: &IoBudget,
) -> Result<DiscoveryResult, DiscoveryError> {
    // If no new channels, return early
    if start_index >= total_n_channels {
        return Ok(DiscoveryResult {
            channels: vec![],
            last_index: None,
            has_more: false,
        });
    }

    // Discover and decrypt each channel
    let capacity = usize::try_from(total_n_channels.saturating_sub(start_index))
        .expect("channel count exceeds usize");
    let mut channels = Vec::with_capacity(capacity);
    let mut index = start_index;
    let mut out_of_budget = false;

    loop {
        // Check if we've processed all channels
        if index >= total_n_channels {
            break;
        }

        // Consume budget for get_channel_info
        if !budget.consume(COST_CHANNEL_INFO) {
            out_of_budget = true;
            break;
        }

        let encrypted = privacy_pool.get_channel_info(recipient_addr, index).await?;

        let info = decrypt_channel_info(&encrypted, private_key)
            .map_err(|source| DiscoveryError::Decryption { index, source })?;

        channels.push(IncomingChannel { index, info });
        index += 1;
    }

    let last_index = channels.last().map(|c| c.index);

    Ok(DiscoveryResult {
        channels,
        last_index,
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

        let count = get_incoming_channel_count(&backend, recipient, &budget)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(count, 0);

        // Test with 0 (start from beginning)
        let result1 = discover_incoming_channels(&backend, recipient, &key, 0, count, &budget)
            .await
            .unwrap();

        // Test with 5 (arbitrary index beyond total)
        let result2 = discover_incoming_channels(&backend, recipient, &key, 5, count, &budget)
            .await
            .unwrap();

        // Both should return empty with no more to discover
        for result in [&result1, &result2] {
            assert_eq!(result.channels.len(), 0);
            assert!(!result.has_more);
        }
    }

    #[tokio::test]
    async fn test_discover_alice_self_channel() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);
        let budget = IoBudget::new(100);

        let count = get_incoming_channel_count(&backend, fixture.constants.alice_address, &budget)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(count, 1);

        let result = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
            0,
            count,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 1, "Alice should have 1 channel");
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

        let count = get_incoming_channel_count(&backend, fixture.constants.bob_address, &budget)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(count, 1);

        let result = discover_incoming_channels(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
            0,
            count,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 1, "Bob should have 1 channel");
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

        let count = get_incoming_channel_count(&backend, fixture.constants.alice_address, &budget)
            .await
            .unwrap()
            .unwrap();

        // First discovery - get all channels
        let result1 = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
            0,
            count,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result1.channels.len(), 1);
        assert!(!result1.has_more);

        // Incremental discovery starting from count (all discovered)
        // Should return empty since we've discovered all channels
        let result2 = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
            count, // Start from 1, but only 1 channel exists
            count,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result2.channels.len(), 0);
        assert!(!result2.has_more);
    }

    #[tokio::test]
    async fn test_get_count_out_of_budget() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // Budget exhausted before getting count
        let budget = IoBudget::new(0);
        let count = get_incoming_channel_count(&backend, fixture.constants.alice_address, &budget)
            .await
            .unwrap();
        assert!(count.is_none(), "Should return None when budget exhausted");
    }

    #[tokio::test]
    async fn test_discover_out_of_budget() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // Get count first with sufficient budget
        let budget = IoBudget::new(100);
        let count = get_incoming_channel_count(&backend, fixture.constants.alice_address, &budget)
            .await
            .unwrap()
            .unwrap();

        // Now discover with insufficient budget (COST_CHANNEL_INFO = 3)
        let budget = IoBudget::new(2);
        let result = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
            0,
            count,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 0);
        assert!(result.has_more, "Should indicate more channels remain");
    }
}
