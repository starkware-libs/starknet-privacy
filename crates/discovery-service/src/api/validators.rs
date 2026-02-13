//! Request validation for sync endpoints.

use std::collections::HashSet;

use axum::http::StatusCode;
use discovery_core::discovery::DiscoveryCursor;
use starknet_core::types::Felt;
use tracing::warn;

use crate::api::types::{error_codes, ApiErrorResponse};
use crate::chain_state::{ChainState, ChainStateError};
use crate::config::ValidationLimits;

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

    // 3. Resolve query block
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

/// Rejects cursors that exceed size limits.
pub fn validate_cursor(
    cursor: &DiscoveryCursor,
    limits: &ValidationLimits,
) -> Result<(), (StatusCode, ApiErrorResponse)> {
    if cursor.channels.len() > limits.max_cursor_channels {
        return Err((
            StatusCode::BAD_REQUEST,
            ApiErrorResponse::with_details(
                error_codes::INVALID_REQUEST,
                format!(
                    "cursor contains {} channels, maximum is {}",
                    cursor.channels.len(),
                    limits.max_cursor_channels
                ),
                serde_json::json!({ "max_channels": limits.max_cursor_channels }),
            ),
        ));
    }
    for ch in cursor.channels.values() {
        if ch.subchannels.len() > limits.max_cursor_subchannels_per_channel {
            return Err((
                StatusCode::BAD_REQUEST,
                ApiErrorResponse::with_details(
                    error_codes::INVALID_REQUEST,
                    format!(
                        "channel cursor contains {} subchannels, maximum is {}",
                        ch.subchannels.len(),
                        limits.max_cursor_subchannels_per_channel
                    ),
                    serde_json::json!({ "max_subchannels_per_channel": limits.max_cursor_subchannels_per_channel }),
                ),
            ));
        }
    }
    Ok(())
}

/// Rejects recipient sets that exceed size limits.
#[allow(dead_code)] // Used by outgoing_sync endpoint (next slice)
pub fn validate_recipients(
    recipients: &HashSet<Felt>,
    limits: &ValidationLimits,
) -> Result<(), (StatusCode, ApiErrorResponse)> {
    if recipients.len() > limits.max_outgoing_recipients {
        return Err((
            StatusCode::BAD_REQUEST,
            ApiErrorResponse::with_details(
                error_codes::INVALID_REQUEST,
                format!(
                    "recipients contains {} entries, maximum is {}",
                    recipients.len(),
                    limits.max_outgoing_recipients
                ),
                serde_json::json!({ "max_recipients": limits.max_outgoing_recipients }),
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain_state::mock::MockChainState;
    use discovery_core::discovery::ChannelCursor;

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
        for channel_index in 0..limits.max_cursor_channels + 1 {
            cursor.channels.insert(
                Felt::from(channel_index as u64),
                ChannelCursor {
                    channel_key: None,
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
            channel_key: None,
            subchannel_discovery_complete: false,
            last_subchannel_index: None,
            subchannels: Default::default(),
        };
        for subchannel_index in 0..limits.max_cursor_subchannels_per_channel + 1 {
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

    // RPC error handling is tested via integration tests with real devnet
}
