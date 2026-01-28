//! Subchannel (token channel) discovery.
//!
//! This module provides functionality to discover and decrypt subchannels
//! for a given channel key. Subchannels represent token-specific channels
//! within a channel.

use starknet_types_core::felt::Felt;

use super::DiscoveryError;
use crate::decryption::decrypt_subchannel_token;
use crate::hashes::compute_subchannel_key;
use crate::storage::IViews;

/// A discovered and decrypted subchannel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subchannel {
    /// The index of this subchannel within the channel.
    pub index: u64,
    /// The decrypted token address.
    pub token: Felt,
}

/// Result of subchannel discovery operation.
#[derive(Debug, Clone)]
pub struct SubchannelDiscoveryResult {
    /// List of discovered and decrypted subchannels.
    pub subchannels: Vec<Subchannel>,
    /// Total number of subchannels discovered.
    /// Use this as `from_index` for incremental discovery.
    pub total_subchannels: u64,
}

/// Discovers and decrypts subchannels for a given channel key.
///
/// # Algorithm
///
/// For each subchannel index starting from `from_index`:
/// 1. Compute `subchannel_key = hash(SUBCHANNEL_KEY_TAG, channel_key, index, 0)`
/// 2. Fetch `EncSubchannelInfo { salt, enc_token }` from storage
/// 3. If `salt == 0`, stop (sentinel - no more subchannels)
/// 4. Decrypt: `token = enc_token - hash(ENC_TOKEN_TAG, channel_key, index, 0, salt)`
///
/// # Arguments
///
/// * `privacy_pool` - Storage backend implementing the IViews trait.
/// * `channel_key` - The channel key to discover subchannels for.
/// * `from_index` - Optional starting index (exclusive). If `Some(n)`, starts from `n+1`.
///   If `None`, discovers all subchannels from index 0.
///
/// # Returns
///
/// A `SubchannelDiscoveryResult` containing all discovered subchannels and metadata
/// for incremental discovery.
pub async fn discover_subchannels<PrivacyPool: IViews>(
    privacy_pool: &PrivacyPool,
    channel_key: Felt,
    from_index: Option<u64>,
) -> Result<SubchannelDiscoveryResult, DiscoveryError> {
    let start_index = match from_index {
        Some(last) => last + 1,
        None => 0,
    };

    let mut subchannels = Vec::new();
    let mut index = start_index;

    loop {
        let subchannel_key = compute_subchannel_key(channel_key, index);
        let encrypted = privacy_pool.get_subchannel_info(subchannel_key).await?;

        // Check for sentinel (salt == 0 means no more subchannels)
        if encrypted.salt == Felt::ZERO {
            break;
        }

        let token = decrypt_subchannel_token(&encrypted, &channel_key, index);

        subchannels.push(Subchannel { index, token });
        index += 1;
    }

    Ok(SubchannelDiscoveryResult {
        subchannels,
        total_subchannels: index,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock_backend::MockBackend;
    use crate::test_fixtures::load_devnet_fixture;

    /// Helper to discover channels and get the channel key for a recipient.
    async fn get_channel_key(
        backend: &MockBackend,
        recipient: Felt,
        viewing_key: &Felt,
    ) -> Option<Felt> {
        use crate::discovery::discover_incoming_channels;

        let result = discover_incoming_channels(backend, recipient, viewing_key, None)
            .await
            .ok()?;

        result.channels.first().map(|c| c.info.channel_key)
    }

    #[tokio::test]
    async fn test_discover_no_subchannels() {
        let backend = MockBackend::empty();
        // Use a random channel key - empty backend returns zero for all slots
        let channel_key = Felt::from_hex_unchecked("0x12345");

        let result = discover_subchannels(&backend, channel_key, None)
            .await
            .unwrap();

        assert_eq!(result.subchannels.len(), 0);
        assert_eq!(result.total_subchannels, 0);
    }

    #[tokio::test]
    async fn test_discover_subchannels_alice_self_channel() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // First discover Alice's incoming channels to get the channel key
        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .expect("Alice should have at least one channel");

        // Now discover subchannels for this channel
        let result = discover_subchannels(&backend, channel_key, None)
            .await
            .unwrap();

        assert_eq!(
            result.subchannels.len(),
            1,
            "Alice's self-channel should have 1 subchannel (STRK)"
        );
        assert_eq!(result.total_subchannels, 1);
        assert_eq!(result.subchannels[0].index, 0);
        // The subchannel token should be STRK
        assert_eq!(result.subchannels[0].token, fixture.constants.strk_token);
    }

    #[tokio::test]
    async fn test_discover_subchannels_bob_incoming_channel() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // First discover Bob's incoming channels to get the channel key
        let channel_key = get_channel_key(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
        )
        .await
        .expect("Bob should have at least one channel");

        // Now discover subchannels for this channel
        let result = discover_subchannels(&backend, channel_key, None)
            .await
            .unwrap();

        assert_eq!(
            result.subchannels.len(),
            1,
            "Bob's channel should have 1 subchannel (STRK)"
        );
        assert_eq!(result.total_subchannels, 1);
        assert_eq!(result.subchannels[0].index, 0);
        // The subchannel token should be STRK
        assert_eq!(result.subchannels[0].token, fixture.constants.strk_token);
    }

    #[tokio::test]
    async fn test_discover_subchannels_incremental() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // First discover Alice's incoming channels to get the channel key
        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .expect("Alice should have at least one channel");

        // First discovery - should find 1 subchannel
        let result1 = discover_subchannels(&backend, channel_key, None)
            .await
            .unwrap();
        assert_eq!(result1.subchannels.len(), 1);
        assert_eq!(result1.total_subchannels, 1);

        // Incremental discovery starting from last index - should find 0 new subchannels
        let result2 =
            discover_subchannels(&backend, channel_key, Some(result1.total_subchannels - 1))
                .await
                .unwrap();
        assert_eq!(result2.subchannels.len(), 0);
        assert_eq!(result2.total_subchannels, 1);
    }
}
