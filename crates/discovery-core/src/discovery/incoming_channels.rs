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
    /// Use this as `from_index` for incremental discovery.
    pub total_channels: u64,
}

/// Discovers and decrypts incoming channels for a recipient.
///
/// # Arguments
///
/// * `privacy_pool` - Storage backend implementing the IViews trait.
/// * `recipient_addr` - The recipient's contract address.
/// * `decryption_key` - The recipient's private viewing key.
/// * `from_index` - Optional starting index (exclusive). If `Some(n)`, starts from `n+1`.
///   If `None`, discovers all channels from index 0.
///
/// # Returns
///
/// A `DiscoveryResult` containing all discovered channels and metadata for
/// incremental discovery.
///
/// # Security
///
/// The caller should zero the `decryption_key` after use by calling
/// `decryption_key.zeroize()` (see `crate::channel_info::Zeroize`).
pub async fn discover_incoming_channels<PrivacyPool: IViews>(
    privacy_pool: &PrivacyPool,
    recipient_addr: Felt,
    decryption_key: &Felt,
    from_index: Option<u64>,
) -> Result<DiscoveryResult, DiscoveryError> {
    // Get total number of channels
    let total_channels = privacy_pool.get_num_of_channels(recipient_addr).await?;

    // Calculate starting index
    let start_index = match from_index {
        Some(last) => last + 1,
        None => 0,
    };

    // If no new channels, return early
    if start_index >= total_channels {
        return Ok(DiscoveryResult {
            channels: vec![],
            total_channels,
        });
    }

    // Discover and decrypt each channel
    let mut channels = Vec::with_capacity((total_channels - start_index) as usize);

    for index in start_index..total_channels {
        let encrypted = privacy_pool.get_channel_info(recipient_addr, index).await?;

        let info = decrypt_channel_info(&encrypted, decryption_key)
            .map_err(|source| DiscoveryError::Decryption { index, source })?;

        channels.push(IncomingChannel { index, info });
    }

    Ok(DiscoveryResult {
        channels,
        total_channels,
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

        let result = discover_incoming_channels(&backend, recipient, &key, None)
            .await
            .unwrap();

        assert_eq!(result.channels.len(), 0);
        assert_eq!(result.total_channels, 0);
    }

    #[tokio::test]
    async fn test_discover_incremental_no_new_channels() {
        let backend = MockBackend::empty();
        let recipient = Felt::from_hex_unchecked("0x123");
        let key = Felt::from(1u64);

        // If from_index is at the end, should return empty
        let result = discover_incoming_channels(&backend, recipient, &key, Some(0))
            .await
            .unwrap();

        assert_eq!(result.channels.len(), 0);
        assert_eq!(result.total_channels, 0);
    }

    #[tokio::test]
    async fn test_discover_alice_self_channel() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let result = discover_incoming_channels(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 1, "Alice should have 1 channel");
        assert_eq!(result.total_channels, 1);
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
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.channels.len(), 1, "Bob should have 1 channel");
        assert_eq!(result.total_channels, 1);
        assert_eq!(result.channels[0].index, 0);
        // Bob's channel is from Alice (transfer)
        assert_eq!(
            result.channels[0].info.sender_addr,
            fixture.constants.alice_address
        );
    }
}
