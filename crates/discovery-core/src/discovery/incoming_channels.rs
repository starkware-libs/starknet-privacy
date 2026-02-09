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

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

use tracing::{debug, trace};

use super::{ChannelCursor, DiscoveryCursor, DiscoveryError, COST_CHANNEL_INFO, COST_NUM_CHANNELS};
use crate::io_budget::IoBudget;
use crate::privacy_pool::decryption::decrypt_channel_info;
use crate::privacy_pool::felt_hex;
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// A discovered and decrypted incoming channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IncomingChannel {
    /// The channel key.
    pub channel_key: Felt,
    /// The sender's address.
    pub sender_addr: Felt,
}

/// Result of channel discovery operation.
#[derive(Debug, Clone)]
pub struct ChannelDiscoveryResult {
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
pub async fn discover_incoming_channels<PrivacyPool: IViews>(
    privacy_pool: &PrivacyPool,
    recipient_addr: Felt,
    private_key: &SecretFelt,
    start_index: u64,
    total_n_channels: u64,
    budget: &IoBudget,
) -> Result<ChannelDiscoveryResult, DiscoveryError> {
    // If no new channels, return early
    if start_index >= total_n_channels {
        return Ok(ChannelDiscoveryResult {
            channels: vec![],
            last_index: None,
            has_more: false,
        });
    }

    // Batch-read as many channels as budget allows in a single RPC call.
    let remaining_channels =
        usize::try_from(total_n_channels.saturating_sub(start_index)).unwrap_or(0);
    let (batch_size, budget_exhausted) =
        budget.consume_up_to(remaining_channels, COST_CHANNEL_INFO);
    if batch_size == 0 {
        return Ok(ChannelDiscoveryResult {
            channels: vec![],
            last_index: None,
            has_more: budget_exhausted,
        });
    }

    let encrypted_batch = privacy_pool
        .get_channel_info_batch(recipient_addr, start_index, batch_size)
        .await?;

    let mut channels = Vec::with_capacity(batch_size);
    let mut last_index: Option<u64> = None;
    for (i, enc_channel_info) in encrypted_batch.into_iter().enumerate() {
        let index = start_index
            + u64::try_from(i)
                .map_err(|_| DiscoveryError::InvalidCursor("channel index overflow".into()))?;

        let info = decrypt_channel_info(&enc_channel_info, private_key)
            .map_err(|source| DiscoveryError::Decryption { index, source })?;

        channels.push(IncomingChannel {
            channel_key: info.channel_key,
            sender_addr: info.sender_addr,
        });
        last_index = Some(index);
    }
    let has_more = batch_size < remaining_channels;

    debug!(
        recipient = felt_hex(&recipient_addr),
        start_index,
        total_n_channels,
        discovered = channels.len(),
        last_index = ?last_index,
        has_more,
        "discover_incoming_channels done"
    );
    for channel in &channels {
        trace!(
            sender = felt_hex(&channel.sender_addr),
            "incoming channel found"
        );
    }

    Ok(ChannelDiscoveryResult {
        channels,
        last_index,
        has_more,
    })
}

/// Discovers incoming channels with cursor-based pagination.
///
/// If `cursor.channel_discovery_complete` is set (by the service once the
/// sentinel channel is reached), returns immediately without consuming budget.
/// Otherwise fetches and caches `total_n_channels`, then delegates to
/// [`discover_incoming_channels`] for new channels.
pub async fn discover_incoming_channels_paginated<S: IViews>(
    pool: &S,
    recipient: Felt,
    private_key: &SecretFelt,
    cursor: &mut DiscoveryCursor,
    budget: &IoBudget,
) -> Result<Vec<IncomingChannel>, DiscoveryError> {
    if cursor.channel_discovery_complete {
        return Ok(Vec::new());
    }

    // 1. Get/cache total_n_channels.
    let total_channels = match cursor.total_n_channels {
        Some(count) => count,
        None => match get_incoming_channel_count(pool, recipient, budget).await? {
            Some(count) => {
                cursor.total_n_channels = Some(count);
                count
            }
            // Budget exhausted before getting count.
            None => return Ok(Vec::new()),
        },
    };

    // 2. All channels already enumerated — stop discovering.
    let start_index = cursor.last_channel_index.map_or(0, |i| i + 1);
    if start_index >= total_channels {
        cursor.channel_discovery_complete = true;
        return Ok(Vec::new());
    }

    // 3. Discover new channels.
    let result = discover_incoming_channels(
        pool,
        recipient,
        private_key,
        start_index,
        total_channels,
        budget,
    )
    .await?;

    // 4. Register new channels in cursor (keyed by sender_addr).
    for channel in &result.channels {
        cursor
            .channels
            .entry(channel.sender_addr)
            .or_insert(ChannelCursor {
                channel_key: Some(channel.channel_key),
                subchannel_discovery_complete: false,
                last_subchannel_index: None,
                subchannels: Default::default(),
            });
    }

    cursor.last_channel_index = result.last_index.or(cursor.last_channel_index);

    // Stop discovering once all channels are enumerated.
    if !result.has_more {
        cursor.channel_discovery_complete = true;
    }

    Ok(result.channels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_backend::MockBackend;
    use crate::test_fixtures::load_devnet_fixture;

    #[tokio::test]
    async fn test_discover_no_channels() {
        let backend = MockBackend::empty();
        let recipient = Felt::from_hex_unchecked("0x123");
        let key = SecretFelt::new(Felt::from(1u64));
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
            assert_eq!(result.last_index, None);
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

        let key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let result = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &key,
            0,
            count,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 1, "Alice should have 1 channel");
        assert_eq!(result.last_index, Some(0));
        assert!(!result.has_more);
        // Alice's channel is a self-channel (change from deposit+transfer)
        assert_eq!(
            result.channels[0].sender_addr,
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

        let key = SecretFelt::new(fixture.constants.bob_viewing_key);
        let result = discover_incoming_channels(
            &backend,
            fixture.constants.bob_address,
            &key,
            0,
            count,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 1, "Bob should have 1 channel");
        assert_eq!(result.last_index, Some(0));
        assert!(!result.has_more);
        // Bob's channel is from Alice (transfer)
        assert_eq!(
            result.channels[0].sender_addr,
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
        assert_eq!(count, 1);

        let key = SecretFelt::new(fixture.constants.alice_viewing_key);

        // First discovery - get all channels
        let result1 = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &key,
            0,
            count,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result1.channels.len(), 1);
        assert_eq!(result1.last_index, Some(0));
        assert!(!result1.has_more);

        // Incremental discovery using last_index + 1 as start_index
        // Should return empty since we've discovered all channels
        let result2 = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &key,
            result1.last_index.unwrap() + 1,
            count,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result2.channels.len(), 0);
        assert_eq!(result2.last_index, None);
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
        assert_eq!(count, None);
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
        assert_eq!(count, 1);

        // Now discover with insufficient budget (COST_CHANNEL_INFO = 3)
        let budget = IoBudget::new(2);
        let key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let result = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &key,
            0,
            count,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 0);
        assert_eq!(result.last_index, None);
        assert!(result.has_more);
    }

    #[tokio::test]
    async fn test_paginated_full_discovery_populates_cursor() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let mut cursor = DiscoveryCursor::default();
        let budget = IoBudget::new(100);
        let key = SecretFelt::new(fixture.constants.bob_viewing_key);

        let channels = discover_incoming_channels_paginated(
            &backend,
            fixture.constants.bob_address,
            &key,
            &mut cursor,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(channels.len(), 1, "Bob should have 1 channel");
        assert_eq!(cursor.total_n_channels, Some(1));
        assert_eq!(cursor.last_channel_index, Some(0));
        assert_eq!(cursor.channels.len(), 1, "1 channel in cursor");
        assert!(cursor.channel_discovery_complete, "discovery complete");

        let sender_addr = channels[0].sender_addr;
        assert!(cursor.channels.contains_key(&sender_addr));
        assert!(
            cursor.channels[&sender_addr].channel_key.is_some(),
            "channel_key should be set for incoming channels"
        );
    }

    #[tokio::test]
    async fn test_paginated_budget_limited_count_returns_empty() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let mut cursor = DiscoveryCursor::default();
        // Budget = 0: can't even fetch channel count
        let budget = IoBudget::new(0);
        let key = SecretFelt::new(fixture.constants.bob_viewing_key);

        let channels = discover_incoming_channels_paginated(
            &backend,
            fixture.constants.bob_address,
            &key,
            &mut cursor,
            &budget,
        )
        .await
        .unwrap();

        assert!(channels.is_empty(), "no budget for count fetch");
        assert!(
            cursor.total_n_channels.is_none(),
            "count should not be cached"
        );
    }
}
