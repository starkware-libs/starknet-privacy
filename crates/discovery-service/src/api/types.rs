//! Shared API types: health response, error response, error codes,
//! and endpoint-specific request/response types.

use std::collections::HashSet;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use discovery_core::discovery::incoming_channels::IncomingChannel;
use discovery_core::discovery::notes::DecryptedNote;
use discovery_core::discovery::outgoing_channels::OutgoingChannel;
use discovery_core::discovery::DiscoveryCursor;
use discovery_core::discovery::DiscoveryError;
use discovery_core::history::types::{HistoryCursor, HistoryTransaction};
use discovery_core::privacy_pool::types::{secret_felt_serde, SecretFelt};
use discovery_core::sync::incoming_state::IncomingSubchannel;
use discovery_core::sync::outgoing_state::OutgoingSubchannel;
use serde::{Deserialize, Serialize};
use starknet_core::types::{BlockId, Felt};
use tower_http::request_id::RequestId;
use tracing::{debug, warn};

use super::block_id_serde;
use crate::chain_state::ChainHead;

/// Response for the health endpoint.
#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub chain_head: Option<ChainHead>,
    pub lag_secs: u64,
}

/// Standard error response format per spec 08-error-handling.md.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiErrorResponse {
    pub error: ApiErrorBody,
}

/// Error body details.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiErrorBody {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub details: Option<serde_json::Value>,
    /// Echoes the `x-request-id` header value bound to this request, so
    /// clients can correlate this error with server-side logs.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub request_id: Option<String>,
}

impl ApiErrorResponse {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            error: ApiErrorBody {
                code: code.to_string(),
                message: message.into(),
                details: None,
                request_id: None,
            },
        }
    }

    pub fn with_details(
        code: &'static str,
        message: impl Into<String>,
        details: serde_json::Value,
    ) -> Self {
        Self {
            error: ApiErrorBody {
                code: code.to_string(),
                message: message.into(),
                details: Some(details),
                request_id: None,
            },
        }
    }

    /// Attaches a request id to the error body, returning the updated response.
    pub fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
        self.error.request_id = Some(request_id.into());
        self
    }
}

/// Builds an HTTP response from an error, attaching `request_id` from the
/// `SetRequestId` layer (if present) so every error body carries the same
/// id the client receives in the `x-request-id` response header.
pub fn into_error_response(
    request_id: Option<&RequestId>,
    status: StatusCode,
    error: ApiErrorResponse,
) -> Response {
    let error = match request_id.and_then(|id| id.header_value().to_str().ok()) {
        Some(id) => error.with_request_id(id),
        None => error,
    };
    (status, Json(error)).into_response()
}

/// Maps [`discovery_core::storage_backend::StorageError`] (e.g. from
/// `StorageBackend::snapshot`) to an HTTP status + API error response.
pub fn storage_error_to_response(
    error: discovery_core::storage_backend::StorageError,
) -> (StatusCode, ApiErrorResponse) {
    use discovery_core::storage_backend::StorageError;
    match error {
        StorageError::ContractNotFound => (
            StatusCode::BAD_REQUEST,
            ApiErrorResponse::new(
                error_codes::CONTRACT_NOT_FOUND,
                "Contract not found at the configured address",
            ),
        ),
        other => {
            debug!("Storage error: {}", other);
            (
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorResponse::new(error_codes::STORAGE_ERROR, "Storage backend error"),
            )
        }
    }
}

/// Maps [`DiscoveryError`] to an HTTP status + API error response.
pub fn discovery_error_to_response(error: DiscoveryError) -> (StatusCode, ApiErrorResponse) {
    match error {
        DiscoveryError::Storage(storage_err) => storage_error_to_response(storage_err),
        DiscoveryError::Decryption { index, source } => {
            warn!("Decryption failed at channel index {}: {}", index, source);
            (
                StatusCode::BAD_REQUEST,
                ApiErrorResponse::new(error_codes::DECRYPTION_FAILED, "Decryption failed"),
            )
        }
        DiscoveryError::TaskPanicked(msg) => {
            warn!("Discovery task panicked: {}", msg);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorResponse::new(error_codes::INTERNAL_ERROR, "Internal discovery error"),
            )
        }
        DiscoveryError::InvalidCursor(msg) => (
            StatusCode::BAD_REQUEST,
            ApiErrorResponse::new(error_codes::INVALID_REQUEST, msg),
        ),
        DiscoveryError::InsufficientBudget { needed, available } => {
            warn!(
                "Insufficient I/O budget: needed {}, available {}",
                needed, available
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorResponse::new(error_codes::INTERNAL_ERROR, "Internal discovery error"),
            )
        }
        DiscoveryError::CostOverflow(cost) => {
            warn!("I/O cost overflow: {} exceeds usize", cost);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorResponse::new(error_codes::INTERNAL_ERROR, "Internal discovery error"),
            )
        }
        DiscoveryError::EventError(msg) => {
            warn!("Event error: {}", msg);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorResponse::new(error_codes::INTERNAL_ERROR, "Internal discovery error"),
            )
        }
    }
}

/// Fields shared by all sync request types.
///
/// Each endpoint-specific request embeds this via `#[serde(flatten)]`
/// so the JSON wire format is unchanged (fields appear at top level).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRequestBase {
    /// The privacy pool contract address.
    pub contract_address: Felt,
    /// The caller's private viewing key.
    #[serde(
        serialize_with = "secret_felt_serde::serialize",
        deserialize_with = "secret_felt_serde::deserialize"
    )]
    pub viewing_key: SecretFelt,
    /// Block hash for reorg detection. Set on first request of a new sync
    /// session to the `block_hash` from your last completed sync.
    /// Server returns 409 if this block was reorged out.
    /// Leave empty on pagination requests or fresh syncs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_known_block: Option<Felt>,
    /// Block identifier to pin storage reads to. Can be a block hash, number,
    /// or tag (`"latest"`, `"pre_confirmed"`, `"l1_accepted"`). When omitted,
    /// resolves to the current head hash. Explicit values pass through as-is.
    /// Only a block hash guarantees consistent reads across paginated requests.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "block_id_serde::option"
    )]
    pub block_ref: Option<BlockId>,
    /// Discovery cursor for pagination. Use the cursor from previous
    /// response to continue discovery.
    #[serde(default)]
    pub cursor: DiscoveryCursor,
}

/// Request body for POST /v1/sync/incoming_state.
///
/// # Sync Flow
///
/// **First request** (fresh sync or new session):
/// ```json
/// {
///   "contract_address": "0x...",
///   "recipient_address": "0x...",
///   "viewing_key": "0x...",
///   "last_known_block": "0x..."  // Optional: for reorg detection
/// }
/// ```
///
/// **Subsequent requests** (pagination within same session):
/// ```json
/// {
///   "contract_address": "0x...",
///   "recipient_address": "0x...",
///   "viewing_key": "0x...",
///   "block_ref": "0x...",  // From previous response
///   "cursor": { ... }      // From previous response
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingSyncRequest {
    /// The recipient's address.
    pub recipient_address: Felt,
    #[serde(flatten)]
    pub base: SyncRequestBase,
}

/// Response body for POST /v1/sync/incoming_state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingSyncResponse {
    /// Block identifier pinning all reads in this response. Pass back as
    /// `block_ref` in subsequent requests for consistency.
    #[serde(with = "block_id_serde")]
    pub block_ref: BlockId,
    /// Discovered incoming channels (one per sender).
    pub channels: Vec<IncomingChannel>,
    /// Discovered incoming subchannels (one per sender×token pair).
    pub subchannels: Vec<IncomingSubchannel>,
    /// Discovered notes with sender and token context.
    pub notes: Vec<DecryptedNote>,
    /// Updated cursor for continuation. Pass back as `cursor` in next request.
    pub cursor: DiscoveryCursor,
}

/// Request body for POST /v1/sync/outgoing_state.
///
/// # Sync Flow
///
/// **First request** (fresh sync):
/// ```json
/// {
///   "contract_address": "0x...",
///   "sender_address": "0x...",
///   "viewing_key": "0x...",
///   "last_known_block": "0x..."  // Optional: for reorg detection
/// }
/// ```
///
/// **Subsequent requests** (pagination within same session):
/// ```json
/// {
///   "contract_address": "0x...",
///   "sender_address": "0x...",
///   "viewing_key": "0x...",
///   "block_ref": "0x...",  // From previous response
///   "cursor": { ... }      // From previous response
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutgoingSyncRequest {
    /// The sender's address.
    pub sender_address: Felt,
    /// Optional filter: only return channels for these recipients.
    /// Recipients without an existing on-chain channel are returned
    /// with `precomputed: true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipients: Option<HashSet<Felt>>,
    #[serde(flatten)]
    pub base: SyncRequestBase,
}

/// Response body for POST /v1/sync/outgoing_state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutgoingSyncResponse {
    /// Block identifier pinning all reads in this response. Pass back as
    /// `block_ref` in subsequent requests for consistency.
    #[serde(with = "block_id_serde")]
    pub block_ref: BlockId,
    /// Discovered outgoing channels (one per recipient). Includes both
    /// on-chain channels (`precomputed: false`) and precomputed channels
    /// for requested recipients (`precomputed: true`).
    pub channels: Vec<OutgoingChannel>,
    /// Discovered outgoing subchannels (one per recipient×token pair).
    pub subchannels: Vec<OutgoingSubchannel>,
    /// Updated cursor for continuation. Pass back as `cursor` in next request.
    pub cursor: DiscoveryCursor,
}

/// Request body for POST /v1/sync/preflight_check.
///
/// A non-paginated readiness check for a `(sender, recipient, token)` tuple.
/// Returns boolean flags indicating what on-chain setup exists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightCheckRequest {
    /// The privacy pool contract address.
    pub contract_address: Felt,
    /// The sender's address.
    pub sender_address: Felt,
    /// The sender's private viewing key.
    #[serde(
        serialize_with = "secret_felt_serde::serialize",
        deserialize_with = "secret_felt_serde::deserialize"
    )]
    pub viewing_key: SecretFelt,
    /// The recipient's address.
    pub recipient: Felt,
    /// The token address.
    pub token: Felt,
}

/// Response body for POST /v1/sync/preflight_check.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightCheckResponse {
    /// Block identifier pinning the reads in this response.
    #[serde(with = "block_id_serde")]
    pub block_ref: BlockId,
    /// Whether the sender has a public key registered on-chain.
    pub sender_registered: bool,
    /// Whether the channel from sender to recipient exists.
    pub channel_exists: bool,
    /// Whether the token subchannel exists within the channel.
    pub subchannel_exists: bool,
}

/// Request body for POST /v1/history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryRequest {
    /// The privacy pool contract address.
    pub contract_address: Felt,
    /// The user's on-chain address (used for withdrawal event filtering).
    pub user_address: Felt,
    /// Maximum number of transactions to return per page.
    pub max_transactions: u32,
    /// Block hash from last completed sync session. Used for reorg detection
    /// on first request. Leave empty on fresh syncs or pagination requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_known_block: Option<Felt>,
    /// Block identifier for storage reads. See [`SyncRequestBase::block_ref`]
    /// for consistency semantics of hash vs number vs tag.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "block_id_serde::option"
    )]
    pub block_ref: Option<BlockId>,
    /// History cursor for pagination. Use the cursor from previous response
    /// to continue scanning.
    #[serde(default)]
    pub cursor: HistoryCursor,
}

/// Response body for POST /v1/history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryResponse {
    /// Block identifier pinning all storage reads.
    #[serde(with = "block_id_serde")]
    pub block_ref: BlockId,
    /// History transactions for the current page.
    pub transactions: Vec<HistoryTransaction>,
    /// Updated cursor for continuation.
    pub cursor: HistoryCursor,
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::http::HeaderValue;
    use http_body_util::BodyExt;

    fn make_request_id(value: &'static str) -> RequestId {
        RequestId::new(HeaderValue::from_static(value))
    }

    #[tokio::test]
    async fn into_error_response_attaches_request_id() {
        let request_id = make_request_id("abc-123");
        let response = into_error_response(
            Some(&request_id),
            StatusCode::BAD_REQUEST,
            ApiErrorResponse::new(error_codes::INVALID_REQUEST, "bad input"),
        );

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body_bytes = response.into_body().collect().await.unwrap().to_bytes();
        let parsed: ApiErrorResponse = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(parsed.error.request_id.as_deref(), Some("abc-123"));
        assert_eq!(parsed.error.code, error_codes::INVALID_REQUEST);
    }

    #[tokio::test]
    async fn into_error_response_omits_request_id_when_absent() {
        let response = into_error_response(
            None,
            StatusCode::BAD_REQUEST,
            ApiErrorResponse::new(error_codes::INVALID_REQUEST, "bad input"),
        );
        let body_bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body_str = std::str::from_utf8(&body_bytes).unwrap();
        assert!(
            !body_str.contains("request_id"),
            "request_id field should be omitted when no id is bound: {body_str}"
        );
    }
}

/// Well-known error codes.
pub mod error_codes {
    pub const INVALID_REQUEST: &str = "INVALID_REQUEST";
    pub const DECRYPTION_FAILED: &str = "DECRYPTION_FAILED";
    pub const BLOCK_REORGED: &str = "BLOCK_REORGED";
    pub const SERVICE_UNAVAILABLE: &str = "SERVICE_UNAVAILABLE";
    pub const CONTRACT_NOT_FOUND: &str = "CONTRACT_NOT_FOUND";
    pub const RPC_UNAVAILABLE: &str = "RPC_UNAVAILABLE";
    pub const STORAGE_ERROR: &str = "STORAGE_ERROR";
    pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";
    pub const OHTTP_DECAPSULATION_FAILED: &str = "OHTTP_DECAPSULATION_FAILED";
    pub const OHTTP_INVALID_FORMAT: &str = "OHTTP_INVALID_FORMAT";
}
