//! Request validation for the incoming sync endpoint.

use axum::http::StatusCode;
use starknet_core::types::{BlockId, Felt};
use tracing::warn;

use crate::api_server::{error_codes, ApiErrorResponse};
use crate::chain_state::{ChainHead, ChainState, ChainStateError};

use super::types::{IncomingSyncCursor, IncomingSyncRequest, DEFAULT_MAX_READS, MAX_READS_CAP};

/// Validated and resolved request data.
///
/// Contains all data needed to run discovery after validation passes.
#[derive(Debug)]
pub struct ValidatedRequest {
    /// The recipient's address.
    pub recipient_address: Felt,
    /// The recipient's private viewing key.
    pub decryption_key: Felt,
    /// Resolved block ID for the query.
    pub query_block: BlockId,
    /// Current chain head. Only present when block_ref was not specified.
    pub head: Option<ChainHead>,
    /// Cursor for pagination.
    pub cursor: IncomingSyncCursor,
    /// Validated max_reads value.
    pub max_reads: u32,
}

impl ValidatedRequest {
    /// Validates and resolves the incoming sync request.
    ///
    /// Performs the following validations:
    /// 1. Validates max_reads doesn't exceed cap
    /// 2. Checks last_known_block hasn't been reorged (if provided)
    /// 3. Resolves block_ref (if provided) or uses current head
    /// 4. Gets current chain head
    pub async fn from_request<B: ChainState>(
        request: IncomingSyncRequest,
        backend: &B,
    ) -> Result<Self, (StatusCode, ApiErrorResponse)> {
        // 1. Validate max_reads
        let max_reads = request.max_reads.unwrap_or(DEFAULT_MAX_READS);
        if max_reads > MAX_READS_CAP {
            return Err((
                StatusCode::BAD_REQUEST,
                ApiErrorResponse::with_details(
                    error_codes::MAX_READS_EXCEEDED,
                    format!("max_reads {} exceeds maximum {}", max_reads, MAX_READS_CAP),
                    serde_json::json!({ "max_allowed": MAX_READS_CAP }),
                ),
            ));
        }

        // 2. If last_known_block provided, check is_canonical
        if let Some(last_known) = request.cursor.last_known_block {
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
        let (query_block, head) = if let Some(block_ref) = request.cursor.block_ref {
            // Use block_ref directly - no validation, no head fetch needed
            (BlockId::Hash(block_ref), None)
        } else {
            // Use current head
            let head = backend.get_head().await.ok_or_else(|| {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    ApiErrorResponse::new(
                        error_codes::SERVICE_UNAVAILABLE,
                        "No indexed head available yet",
                    ),
                )
            })?;
            (BlockId::Hash(head.block_hash), Some(head))
        };

        Ok(ValidatedRequest {
            recipient_address: request.recipient_address,
            decryption_key: request.decryption_key,
            query_block,
            head,
            cursor: request.cursor,
            max_reads,
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
            cursor: Default::default(),
            max_reads: None,
        }
    }

    #[tokio::test]
    async fn test_valid_request_returns_head() {
        let backend = MockChainState::new();
        let request = make_request();

        let result = ValidatedRequest::from_request(request, &backend).await;
        assert!(result.is_ok());

        let validated = result.unwrap();
        assert_eq!(validated.max_reads, DEFAULT_MAX_READS);
        // Head is returned when no block_ref specified
        assert!(validated.head.is_some());
        assert_eq!(validated.head.unwrap().block_number, 100);
    }

    #[tokio::test]
    async fn test_block_ref_skips_head_fetch() {
        let backend = MockChainState::new();
        let mut request = make_request();
        request.cursor.block_ref = Some(Felt::from_hex_unchecked("0xabc"));

        let result = ValidatedRequest::from_request(request, &backend).await;
        assert!(result.is_ok());

        let validated = result.unwrap();
        // Head is NOT returned when block_ref is specified
        assert!(validated.head.is_none());
        // Query block is set to block_ref
        assert_eq!(
            validated.query_block,
            BlockId::Hash(Felt::from_hex_unchecked("0xabc"))
        );
    }

    #[tokio::test]
    async fn test_max_reads_exceeded() {
        let backend = MockChainState::new();
        let mut request = make_request();
        request.max_reads = Some(MAX_READS_CAP + 1);

        let result = ValidatedRequest::from_request(request, &backend).await;
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error.error.code, error_codes::MAX_READS_EXCEEDED);
    }

    #[tokio::test]
    async fn test_block_reorged() {
        let backend = MockChainState::new();
        let mut request = make_request();
        request.cursor.last_known_block = Some(Felt::from_hex_unchecked("0x999")); // Not canonical

        let result = ValidatedRequest::from_request(request, &backend).await;
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error.error.code, error_codes::BLOCK_REORGED);
    }

    #[tokio::test]
    async fn test_no_head_available_without_block_ref() {
        let backend = MockChainState::with_no_head();
        let request = make_request();

        let result = ValidatedRequest::from_request(request, &backend).await;
        assert!(result.is_err());

        let (status, error) = result.unwrap_err();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.error.code, error_codes::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn test_block_ref_works_without_head() {
        // When block_ref is specified, we don't need the head
        let backend = MockChainState::with_no_head();
        let mut request = make_request();
        request.cursor.block_ref = Some(Felt::from_hex_unchecked("0xabc"));

        let result = ValidatedRequest::from_request(request, &backend).await;
        assert!(result.is_ok());

        let validated = result.unwrap();
        assert!(validated.head.is_none());
    }

    // RPC error handling is tested via integration tests with real devnet
}
