//! Request validation for sync endpoints.

use std::collections::HashSet;

use axum::http::StatusCode;
use discovery_core::privacy_pool::types::SecretFelt;
use discovery_core::DiscoveryCursor;
use starknet_core::types::{BlockId, Felt};
use tracing::warn;

use crate::api_server::{error_codes, ApiErrorResponse};
use crate::chain_state::{ChainState, ChainStateError};
use crate::config::ValidationLimits;

use super::types::IncomingSyncRequest;

/// Validated sync parameters shared by incoming and outgoing endpoints.
pub(crate) struct ValidatedSyncParams {
    /// Resolved block ID for the query.
    pub query_block: BlockId,
    /// Block hash pinning all reads (from head or request).
    pub block_ref: Felt,
    /// Cursor for pagination.
    pub cursor: DiscoveryCursor,
}

/// Validates sync parameters common to both incoming and outgoing endpoints.
///
/// Performs the following:
/// 1. Validates cursor size limits
/// 2. Checks last_known_block hasn't been reorged (if provided)
/// 3. Resolves block_ref (if provided) or uses current head
pub(crate) async fn validate_sync_params<B: ChainState>(
    last_known_block: Option<Felt>,
    block_ref: Option<Felt>,
    cursor: DiscoveryCursor,
    backend: &B,
    limits: &ValidationLimits,
) -> Result<ValidatedSyncParams, (StatusCode, ApiErrorResponse)> {
    // 1. Validate cursor size
    validate_cursor(&cursor, limits)?;

    // 2. If last_known_block provided, check is_canonical
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

    Ok(ValidatedSyncParams {
        query_block: BlockId::Hash(block_ref),
        block_ref,
        cursor,
    })
}

/// Rejects cursors that exceed size limits.
fn validate_cursor(
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
pub(crate) fn validate_recipients(
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

/// Validated and resolved request data for the incoming sync endpoint.
///
/// Contains all data needed to run discovery after validation passes.
#[derive(Debug)]
pub struct ValidatedRequest {
    /// The recipient's address.
    pub recipient_address: Felt,
    /// The recipient's private viewing key.
    pub decryption_key: SecretFelt,
    /// Resolved block ID for the query.
    pub query_block: BlockId,
    /// Block hash pinning all reads (from head or request).
    pub block_ref: Felt,
    /// Cursor for pagination.
    pub cursor: DiscoveryCursor,
}

impl ValidatedRequest {
    /// Validates and resolves the incoming sync request.
    pub async fn from_request<B: ChainState>(
        request: IncomingSyncRequest,
        backend: &B,
        limits: &ValidationLimits,
    ) -> Result<Self, (StatusCode, ApiErrorResponse)> {
        let params = validate_sync_params(
            request.last_known_block,
            request.block_ref,
            request.cursor,
            backend,
            limits,
        )
        .await?;

        Ok(ValidatedRequest {
            recipient_address: request.recipient_address,
            decryption_key: SecretFelt::new(request.decryption_key),
            query_block: params.query_block,
            block_ref: params.block_ref,
            cursor: params.cursor,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain_state::mock::MockChainState;

    fn make_request() -> IncomingSyncRequest {
        IncomingSyncRequest {
            recipient_address: Felt::from_hex_unchecked("0x1"),
            decryption_key: Felt::from_hex_unchecked("0x2"),
            last_known_block: None,
            block_ref: None,
            cursor: Default::default(),
        }
    }

    #[tokio::test]
    async fn test_valid_request_uses_head_as_block_ref() {
        let backend = MockChainState::new();
        let limits = ValidationLimits::default();
        let request = make_request();

        let validated = ValidatedRequest::from_request(request, &backend, &limits)
            .await
            .unwrap();
        // block_ref is set from head when not specified in request
        assert_eq!(validated.query_block, BlockId::Hash(validated.block_ref));
    }

    #[tokio::test]
    async fn test_block_ref_used_directly() {
        let backend = MockChainState::new();
        let limits = ValidationLimits::default();
        let mut request = make_request();
        request.block_ref = Some(Felt::from_hex_unchecked("0xabc"));

        let validated = ValidatedRequest::from_request(request, &backend, &limits)
            .await
            .unwrap();
        assert_eq!(validated.block_ref, Felt::from_hex_unchecked("0xabc"));
        assert_eq!(
            validated.query_block,
            BlockId::Hash(Felt::from_hex_unchecked("0xabc"))
        );
    }

    #[tokio::test]
    async fn test_block_reorged() {
        let backend = MockChainState::new();
        let limits = ValidationLimits::default();
        let mut request = make_request();
        request.last_known_block = Some(Felt::from_hex_unchecked("0x999")); // Not canonical

        let result = ValidatedRequest::from_request(request, &backend, &limits).await;
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error.error.code, error_codes::BLOCK_REORGED);
    }

    #[tokio::test]
    async fn test_no_head_available_without_block_ref() {
        let backend = MockChainState::with_no_head();
        let limits = ValidationLimits::default();
        let request = make_request();

        let result = ValidatedRequest::from_request(request, &backend, &limits).await;
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.error.code, error_codes::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn test_block_ref_works_without_head() {
        // When block_ref is specified, we don't need the head
        let backend = MockChainState::with_no_head();
        let limits = ValidationLimits::default();
        let mut request = make_request();
        request.block_ref = Some(Felt::from_hex_unchecked("0xabc"));

        let validated = ValidatedRequest::from_request(request, &backend, &limits)
            .await
            .unwrap();
        assert_eq!(validated.block_ref, Felt::from_hex_unchecked("0xabc"));
    }

    #[tokio::test]
    async fn test_cursor_too_many_channels() {
        let backend = MockChainState::new();
        let limits = ValidationLimits::default();
        let mut request = make_request();
        for i in 0..limits.max_cursor_channels + 1 {
            request.cursor.channels.insert(
                Felt::from(i as u64),
                discovery_core::ChannelCursor {
                    channel_key: None,
                    subchannel_discovery_complete: false,
                    last_subchannel_index: None,
                    subchannels: Default::default(),
                },
            );
        }

        let result = ValidatedRequest::from_request(request, &backend, &limits).await;
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error.error.code, error_codes::INVALID_REQUEST);
    }

    #[tokio::test]
    async fn test_cursor_too_many_subchannels() {
        let backend = MockChainState::new();
        let limits = ValidationLimits::default();
        let mut request = make_request();
        let mut ch = discovery_core::ChannelCursor {
            channel_key: None,
            subchannel_discovery_complete: false,
            last_subchannel_index: None,
            subchannels: Default::default(),
        };
        for i in 0..limits.max_cursor_subchannels_per_channel + 1 {
            ch.subchannels
                .insert(Felt::from(i as u64), Default::default());
        }
        request.cursor.channels.insert(Felt::ONE, ch);

        let result = ValidatedRequest::from_request(request, &backend, &limits).await;
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error.error.code, error_codes::INVALID_REQUEST);
    }

    #[tokio::test]
    async fn test_validate_recipients_too_many() {
        let limits = ValidationLimits::default();
        let recipients: HashSet<Felt> = (0..limits.max_outgoing_recipients + 1)
            .map(|i| Felt::from(i as u64))
            .collect();

        let result = validate_recipients(&recipients, &limits);
        assert!(result.is_err());

        let (status, _) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    // RPC error handling is tested via integration tests with real devnet
}
