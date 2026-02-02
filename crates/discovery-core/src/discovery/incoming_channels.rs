//! Incoming channel discovery.
//!
//! This module provides functionality to discover and decrypt incoming channels
//! for a recipient address.

use starknet_types_core::felt::Felt;

use super::DiscoveryError;
use crate::decryption::decrypt_channel_info;
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
    /// Total number of channels for this recipient.
    /// Use this as `start_index` for incremental discovery.
    pub total_n_channels: u64,
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
) -> Result<DiscoveryResult, DiscoveryError> {
    // Get total number of channels
    let total_n_channels = privacy_pool.get_num_of_channels(recipient_addr).await?;

    // If no new channels, return early
    if start_index >= total_n_channels {
        return Ok(DiscoveryResult {
            channels: vec![],
            total_n_channels,
        });
    }

    // Discover and decrypt each channel
    let capacity = usize::try_from(total_n_channels.saturating_sub(start_index))
        .expect("channel count exceeds usize");
    let mut channels = Vec::with_capacity(capacity);

    for index in start_index..total_n_channels {
        let encrypted = privacy_pool.get_channel_info(recipient_addr, index).await?;

        let info = decrypt_channel_info(&encrypted, private_key)
            .map_err(|source| DiscoveryError::Decryption { index, source })?;

        channels.push(IncomingChannel { index, info });
    }

    Ok(DiscoveryResult {
        channels,
        total_n_channels,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde::Deserialize;

    use super::*;
    use crate::mock_backend::MockBackend;

    // TODO: Refactor fixture loading to be shared across test modules.
    #[derive(Deserialize)]
    struct DevnetFixture {
        constants: DevnetConstants,
        slots: HashMap<Felt, Felt>,
    }

    #[derive(Deserialize)]
    struct DevnetConstants {
        alice_address: Felt,
        alice_viewing_key: Felt,
        bob_address: Felt,
        bob_viewing_key: Felt,
    }

    fn load_devnet_fixture() -> DevnetFixture {
        const JSON: &str = include_str!("../../tests/fixtures/devnet-state.json");
        serde_json::from_str(JSON).expect("failed to parse devnet fixture")
    }

    #[tokio::test]
    async fn test_discover_no_channels() {
        let backend = MockBackend::empty();
        let recipient = Felt::from_hex_unchecked("0x123");
        let key = Felt::from(1u64);

        // Test with 0 (start from beginning)
        let result1 = discover_incoming_channels(&backend, recipient, &key, 0)
            .await
            .unwrap();

        // Test with 5 (arbitrary index beyond total)
        let result2 = discover_incoming_channels(&backend, recipient, &key, 5)
            .await
            .unwrap();

        // Both should return empty
        for result in [&result1, &result2] {
            assert_eq!(result.channels.len(), 0);
            assert_eq!(result.total_n_channels, 0);
        }
    }

    #[tokio::test]
    async fn test_discover_alice_self_channel() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let result = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
            0,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 1, "Alice should have 1 channel");
        assert_eq!(result.total_n_channels, 1);
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

        let result = discover_incoming_channels(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
            0,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 1, "Bob should have 1 channel");
        assert_eq!(result.total_n_channels, 1);
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

        // First discovery - get all channels
        let result1 = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
            0,
        )
        .await
        .unwrap();

        assert_eq!(result1.channels.len(), 1);
        assert_eq!(result1.total_n_channels, 1);

        // Incremental discovery using total_n_channels as start_index
        // Should return empty since we've discovered all channels
        let result2 = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
            result1.total_n_channels, // Start from 1, but only 1 channel exists
        )
        .await
        .unwrap();

        assert_eq!(result2.channels.len(), 0);
        assert_eq!(result2.total_n_channels, 1); // Total unchanged
    }
}
