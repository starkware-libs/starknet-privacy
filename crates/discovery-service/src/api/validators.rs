//! Request validation for sync endpoints.

use std::collections::HashSet;

use axum::http::StatusCode;
use discovery_core::discovery::DiscoveryCursor;
use discovery_core::storage_backend::{StorageError, StorageSnapshot};
use starknet_core::types::Felt;
use tracing::warn;

use crate::api::types::{error_codes, ApiErrorResponse};
use crate::chain_state::{ChainState, ChainStateError};
use crate::config::ValidationLimits;
use crate::public_key_cache::PublicKeyCache;

/// Validates block reference for sync endpoints.
///
/// Performs the following:
/// 1. Checks last_known_block hasn't been reorged (if provided)
/// 2. Resolves block_ref (if provided) or uses current head
pub async fn validate_block_ref<B: ChainState>(
    last_known_block: Option<Felt>,
    block_ref: Option<Felt>,
    backend: &B,
) -> Result<Felt, (StatusCode, ApiErrorResponse)> {
    // last_known_block is for first requests, block_ref is for pagination — never both.
    if last_known_block.is_some() && block_ref.is_some() {
        return Err((
            StatusCode::BAD_REQUEST,
            ApiErrorResponse::new(
                error_codes::INVALID_REQUEST,
                "last_known_block and block_ref are mutually exclusive",
            ),
        ));
    }

    // 1. If last_known_block provided, check is_canonical
    if let Some(last_known) = last_known_block {
        match backend.is_canonical(last_known).await {
            Ok(true) => {}
            Ok(false) => {
                return Err((
                    StatusCode::CONFLICT,
                    ApiErrorResponse::new(
                        error_codes::BLOCK_REORGED,
                        "last_known_block was reorged out; client should re-sync",
                    ),
                ));
            }
            Err(ChainStateError::RpcError(e)) => {
                warn!("RPC error checking is_canonical: {}", e);
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    ApiErrorResponse::new(
                        error_codes::RPC_UNAVAILABLE,
                        "Upstream RPC is unavailable",
                    ),
                ));
            }
        }
    }

    // 2. Resolve query block
    //
    // If block_ref is specified, use it directly without validation.
    // It's the client's responsibility to use a valid block_ref (typically
    // from the cursor returned in a previous response). If invalid, the RPC
    // call will fail and discovery will return an error.
    let block_ref = if let Some(block_ref) = block_ref {
        block_ref
    } else {
        let head = backend.get_head().await.ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorResponse::new(
                    error_codes::SERVICE_UNAVAILABLE,
                    "No indexed head available yet",
                ),
            )
        })?;
        head.block_hash
    };

    Ok(block_ref)
}

/// Rejects a value that exceeds an upper bound.
fn validate_bound(
    actual_size: usize,
    max_allowed: usize,
    field_name: &str,
) -> Result<(), (StatusCode, ApiErrorResponse)> {
    if actual_size > max_allowed {
        return Err((
            StatusCode::BAD_REQUEST,
            ApiErrorResponse::new(
                error_codes::INVALID_REQUEST,
                format!(
                    "{} contains {} entries, maximum is {}",
                    field_name, actual_size, max_allowed
                ),
            ),
        ));
    }
    Ok(())
}

/// Rejects cursors that exceed size limits.
pub fn validate_cursor(
    cursor: &DiscoveryCursor,
    limits: &ValidationLimits,
) -> Result<(), (StatusCode, ApiErrorResponse)> {
    validate_bound(
        cursor.channels.len(),
        limits.cursor_limits.max_channels,
        "cursor channels",
    )?;

    let max_notes = 1u64
        .checked_shl(limits.cursor_limits.max_note_log_index)
        .unwrap_or(u64::MAX);

    for channel_cursor in cursor.channels.values() {
        validate_bound(
            channel_cursor.subchannels.len(),
            limits.cursor_limits.max_subchannels,
            "channel subchannels",
        )?;

        for subchannel_cursor in channel_cursor.subchannels.values() {
            if let Some(total_n_notes) = subchannel_cursor.total_n_notes {
                if total_n_notes > max_notes {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        ApiErrorResponse::new(
                            error_codes::INVALID_REQUEST,
                            format!(
                                "total_n_notes {} exceeds maximum {}",
                                total_n_notes, max_notes
                            ),
                        ),
                    ));
                }
            }
            if let Some(last_note_index) = subchannel_cursor.last_note_index {
                if last_note_index >= max_notes {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        ApiErrorResponse::new(
                            error_codes::INVALID_REQUEST,
                            format!(
                                "last_note_index {} exceeds maximum valid index {}",
                                last_note_index,
                                max_notes - 1
                            ),
                        ),
                    ));
                }
            }
        }
    }
    Ok(())
}

/// Rejects recipient sets that exceed size limits.
pub fn validate_recipients(
    recipients: &HashSet<Felt>,
    limits: &ValidationLimits,
) -> Result<(), (StatusCode, ApiErrorResponse)> {
    validate_bound(
        recipients.len(),
        limits.max_outgoing_recipients,
        "recipients",
    )
}

/// Validates that the viewing key matches the public key registered on-chain for the given address.
///
/// Derives the public key from `viewing_key` via EC scalar multiplication and compares it against
/// the on-chain registered public key. Skips validation if the user is not registered (zero public
/// key). Returns `INVALID_REQUEST` on mismatch.
pub async fn validate_viewing_key<S: StorageSnapshot>(
    viewing_key: &Felt,
    user_address: Felt,
    snapshot: &S,
    cache: &PublicKeyCache,
) -> Result<(), (StatusCode, ApiErrorResponse)> {
    let contract_address = snapshot.contract_address();
    let registered_public_key = if let Some(cached_key) = cache.get(contract_address, user_address)
    {
        cached_key
    } else {
        let fetched_key = snapshot
            .get_public_key(user_address)
            .await
            .map_err(|storage_error| match storage_error {
                StorageError::ContractNotFound => (
                    StatusCode::BAD_REQUEST,
                    ApiErrorResponse::new(
                        error_codes::CONTRACT_NOT_FOUND,
                        "Contract not found at the configured address",
                    ),
                ),
                other => {
                    warn!("Storage error fetching public key: {}", other);
                    (
                        StatusCode::SERVICE_UNAVAILABLE,
                        ApiErrorResponse::new(
                            error_codes::RPC_UNAVAILABLE,
                            "Upstream RPC is unavailable",
                        ),
                    )
                }
            })?;

        cache.insert(contract_address, user_address, fetched_key);
        fetched_key
    };

    // Skip validation for unregistered users (zero public key).
    if registered_public_key == Felt::ZERO {
        return Ok(());
    }

    let derived_public_key = starknet_crypto::get_public_key(viewing_key);

    if derived_public_key != registered_public_key {
        return Err((
            StatusCode::BAD_REQUEST,
            ApiErrorResponse::new(
                error_codes::INVALID_REQUEST,
                "viewing_key does not match the registered public key for the given address",
            ),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain_state::mock::MockChainState;
    use discovery_core::discovery::{ChannelCursor, SubchannelCursor};
    use discovery_core::privacy_pool::types::SecretFelt;

    #[tokio::test]
    async fn test_valid_request_uses_head_as_block_ref() {
        let backend = MockChainState::new();

        let block_ref = validate_block_ref(None, None, &backend).await.unwrap();
        assert_ne!(block_ref, Felt::ZERO);
    }

    #[tokio::test]
    async fn test_block_ref_used_directly() {
        let backend = MockChainState::new();

        let block_ref = validate_block_ref(None, Some(Felt::from_hex_unchecked("0xabc")), &backend)
            .await
            .unwrap();
        assert_eq!(block_ref, Felt::from_hex_unchecked("0xabc"));
    }

    #[tokio::test]
    async fn test_block_reorged() {
        let backend = MockChainState::new();

        let result =
            validate_block_ref(Some(Felt::from_hex_unchecked("0x999")), None, &backend).await;
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error.error.code, error_codes::BLOCK_REORGED);
    }

    #[tokio::test]
    async fn test_no_head_available_without_block_ref() {
        let backend = MockChainState::with_no_head();

        let result = validate_block_ref(None, None, &backend).await;
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.error.code, error_codes::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn test_block_ref_works_without_head() {
        let backend = MockChainState::with_no_head();

        let block_ref = validate_block_ref(None, Some(Felt::from_hex_unchecked("0xabc")), &backend)
            .await
            .unwrap();
        assert_eq!(block_ref, Felt::from_hex_unchecked("0xabc"));
    }

    #[tokio::test]
    async fn test_cursor_too_many_channels() {
        let limits = ValidationLimits::default();
        let mut cursor = DiscoveryCursor::default();
        for channel_index in 0..limits.cursor_limits.max_channels + 1 {
            cursor.channels.insert(
                Felt::from(channel_index as u64),
                ChannelCursor {
                    channel_key: SecretFelt::new(Felt::ZERO),
                    subchannel_discovery_complete: false,
                    last_subchannel_index: None,
                    subchannels: Default::default(),
                },
            );
        }

        let result = validate_cursor(&cursor, &limits);
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error.error.code, error_codes::INVALID_REQUEST);
    }

    #[tokio::test]
    async fn test_cursor_too_many_subchannels() {
        let limits = ValidationLimits::default();
        let mut cursor = DiscoveryCursor::default();
        let mut channel_cursor = ChannelCursor {
            channel_key: SecretFelt::new(Felt::ZERO),
            subchannel_discovery_complete: false,
            last_subchannel_index: None,
            subchannels: Default::default(),
        };
        for subchannel_index in 0..limits.cursor_limits.max_subchannels + 1 {
            channel_cursor
                .subchannels
                .insert(Felt::from(subchannel_index as u64), Default::default());
        }
        cursor.channels.insert(Felt::ONE, channel_cursor);

        let result = validate_cursor(&cursor, &limits);
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error.error.code, error_codes::INVALID_REQUEST);
    }

    #[tokio::test]
    async fn test_validate_recipients_too_many() {
        let limits = ValidationLimits::default();
        let recipients: HashSet<Felt> = (0..limits.max_outgoing_recipients + 1)
            .map(|recipient_index| Felt::from(recipient_index as u64))
            .collect();

        let result = validate_recipients(&recipients, &limits);
        assert!(result.is_err());

        let (status, _) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_both_block_ref_and_last_known_block_rejected() {
        let backend = MockChainState::new();

        let result = validate_block_ref(
            Some(Felt::from_hex_unchecked("0x111")),
            Some(Felt::from_hex_unchecked("0x222")),
            &backend,
        )
        .await;
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error.error.code, error_codes::INVALID_REQUEST);
        assert!(error.error.message.contains("mutually exclusive"));
    }

    #[test]
    fn test_cursor_total_n_notes_exceeds_bound() {
        let limits = ValidationLimits::default();
        // max_note_log_index=30 → max_notes = 2^30 = 1_073_741_824
        let max_notes = 1u64 << limits.cursor_limits.max_note_log_index;

        let mut cursor = DiscoveryCursor::default();
        let mut channel_cursor = ChannelCursor {
            channel_key: SecretFelt::new(Felt::ZERO),
            subchannel_discovery_complete: false,
            last_subchannel_index: None,
            subchannels: Default::default(),
        };
        channel_cursor.subchannels.insert(
            Felt::ONE,
            SubchannelCursor {
                total_n_notes: Some(max_notes + 1),
                ..Default::default()
            },
        );
        cursor.channels.insert(Felt::ONE, channel_cursor);

        let result = validate_cursor(&cursor, &limits);
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error.error.message.contains("total_n_notes"));
    }

    #[test]
    fn test_cursor_last_note_index_exceeds_bound() {
        let limits = ValidationLimits::default();
        let max_notes = 1u64 << limits.cursor_limits.max_note_log_index;

        let mut cursor = DiscoveryCursor::default();
        let mut channel_cursor = ChannelCursor {
            channel_key: SecretFelt::new(Felt::ZERO),
            subchannel_discovery_complete: false,
            last_subchannel_index: None,
            subchannels: Default::default(),
        };
        channel_cursor.subchannels.insert(
            Felt::ONE,
            SubchannelCursor {
                // last_note_index is 0-based, so max_notes (= 2^30) is out of bounds
                last_note_index: Some(max_notes),
                ..Default::default()
            },
        );
        cursor.channels.insert(Felt::ONE, channel_cursor);

        let result = validate_cursor(&cursor, &limits);
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error.error.message.contains("last_note_index"));
    }

    #[test]
    fn test_cursor_valid_note_bounds() {
        let limits = ValidationLimits::default();
        let max_notes = 1u64 << limits.cursor_limits.max_note_log_index;

        let mut cursor = DiscoveryCursor::default();
        let mut channel_cursor = ChannelCursor {
            channel_key: SecretFelt::new(Felt::ZERO),
            subchannel_discovery_complete: false,
            last_subchannel_index: None,
            subchannels: Default::default(),
        };
        channel_cursor.subchannels.insert(
            Felt::ONE,
            SubchannelCursor {
                total_n_notes: Some(max_notes),
                last_note_index: Some(max_notes - 1),
                ..Default::default()
            },
        );
        cursor.channels.insert(Felt::ONE, channel_cursor);

        let result = validate_cursor(&cursor, &limits);
        assert!(result.is_ok());
    }

    // RPC error handling is tested via integration tests with real devnet

    mod viewing_key_validation {
        use super::*;
        use discovery_core::privacy_pool::storage_slots;
        use discovery_core::storage_backend::MockBackend;
        use starknet_core::types::BlockId;

        const TEST_VIEWING_KEY: Felt =
            Felt::from_hex_unchecked("0x1234567890abcdef1234567890abcdef");
        const CONTRACT_ADDRESS: Felt = Felt::from_hex_unchecked("0xc0ffee");
        const USER_ADDRESS: Felt = Felt::from_hex_unchecked("0xface");

        /// Thin wrapper around [`MockBackend`] that implements [`StorageSnapshot`].
        struct MockSnapshot {
            backend: MockBackend,
            contract_address: Felt,
        }

        impl MockSnapshot {
            fn new(backend: MockBackend, contract_address: Felt) -> Self {
                Self {
                    backend,
                    contract_address,
                }
            }
        }

        #[async_trait::async_trait]
        impl discovery_core::storage_backend::RawStorageAccess for MockSnapshot {
            async fn read_slot(&self, slot: Felt) -> Result<Felt, StorageError> {
                self.backend.read_slot(slot).await
            }

            async fn read_slots(&self, slots: Vec<Felt>) -> Result<Vec<Felt>, StorageError> {
                self.backend.read_slots(slots).await
            }

            async fn read_slots_with_block(
                &self,
                slots: Vec<Felt>,
            ) -> Result<Vec<starknet_core::types::StorageResult>, StorageError> {
                self.backend.read_slots_with_block(slots).await
            }
        }

        #[async_trait::async_trait]
        impl StorageSnapshot for MockSnapshot {
            fn contract_address(&self) -> Felt {
                self.contract_address
            }

            fn block_id(&self) -> BlockId {
                BlockId::Tag(starknet_core::types::BlockTag::Latest)
            }
        }

        fn make_mock_with_public_key(public_key: Felt) -> MockSnapshot {
            let mut backend = MockBackend::empty();
            let slot = storage_slots::public_key(USER_ADDRESS);
            backend.insert(slot, public_key);
            MockSnapshot::new(backend, CONTRACT_ADDRESS)
        }

        #[tokio::test]
        async fn test_valid_viewing_key_passes() {
            let expected_public_key = starknet_crypto::get_public_key(&TEST_VIEWING_KEY);
            let mock = make_mock_with_public_key(expected_public_key);
            let cache = PublicKeyCache::new(100);

            let result = validate_viewing_key(&TEST_VIEWING_KEY, USER_ADDRESS, &mock, &cache).await;
            assert!(result.is_ok());
        }

        #[tokio::test]
        async fn test_mismatched_viewing_key_returns_400() {
            let wrong_key = Felt::from_hex_unchecked("0xdeadbeef");
            // Register a public key that does NOT match wrong_key
            let registered_public_key = starknet_crypto::get_public_key(&TEST_VIEWING_KEY);
            let mock = make_mock_with_public_key(registered_public_key);
            let cache = PublicKeyCache::new(100);

            let result = validate_viewing_key(&wrong_key, USER_ADDRESS, &mock, &cache).await;
            assert!(result.is_err());

            let (status, error) = result.unwrap_err();
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(error.error.code, error_codes::INVALID_REQUEST);
            assert!(error.error.message.contains("viewing_key does not match"));
        }

        #[tokio::test]
        async fn test_unregistered_user_skips_validation() {
            // MockBackend returns Felt::ZERO for missing slots, simulating unregistered user
            let mock = MockSnapshot::new(MockBackend::empty(), CONTRACT_ADDRESS);
            let cache = PublicKeyCache::new(100);

            let wrong_key = Felt::from_hex_unchecked("0xdeadbeef");
            let result = validate_viewing_key(&wrong_key, USER_ADDRESS, &mock, &cache).await;
            assert!(result.is_ok());
        }

        #[tokio::test]
        async fn test_cache_hit_skips_storage_lookup() {
            let expected_public_key = starknet_crypto::get_public_key(&TEST_VIEWING_KEY);

            // Empty mock — no storage slots populated. If the code hits storage,
            // it will get Felt::ZERO (unregistered) and skip validation — which would
            // be wrong. Pre-populate cache so storage is never called.
            let mock = MockSnapshot::new(MockBackend::empty(), CONTRACT_ADDRESS);
            let cache = PublicKeyCache::new(100);
            cache.insert(CONTRACT_ADDRESS, USER_ADDRESS, expected_public_key);

            let result = validate_viewing_key(&TEST_VIEWING_KEY, USER_ADDRESS, &mock, &cache).await;
            assert!(result.is_ok());

            // Verify: a wrong key should fail even with empty storage, proving
            // the cache was used (storage would return ZERO → skip validation).
            let wrong_key = Felt::from_hex_unchecked("0xdeadbeef");
            let result = validate_viewing_key(&wrong_key, USER_ADDRESS, &mock, &cache).await;
            assert!(result.is_err());
        }
    }
}
