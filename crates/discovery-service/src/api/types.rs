//! Shared API types: health response, error response, error codes,
//! and endpoint-specific request/response types.

use std::collections::HashSet;

use axum::http::StatusCode;
use discovery_core::discovery::incoming_channels::IncomingChannel;
use discovery_core::discovery::notes::DecryptedNote;
use discovery_core::discovery::outgoing_channels::OutgoingChannel;
use discovery_core::discovery::DiscoveryCursor;
use discovery_core::discovery::DiscoveryError;
use discovery_core::privacy_pool::types::{secret_felt_serde, SecretFelt};
use discovery_core::sync::incoming_state::IncomingSubchannel;
use discovery_core::sync::outgoing_state::OutgoingSubchannel;
use serde::{Deserialize, Serialize};
use starknet_core::types::Felt;
use tracing::warn;

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
}

impl ApiErrorResponse {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            error: ApiErrorBody {
                code: code.to_string(),
                message: message.into(),
                details: None,
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
            },
        }
    }
}

/// Maps [`DiscoveryError`] to an HTTP status + API error response.
pub fn discovery_error_to_response(error: DiscoveryError) -> (StatusCode, ApiErrorResponse) {
    match error {
        DiscoveryError::Storage(storage_err) => {
            use discovery_core::storage_backend::StorageError;
            if matches!(storage_err, StorageError::ContractNotFound) {
                warn!("Contract not found during discovery");
                (
                    StatusCode::BAD_REQUEST,
                    ApiErrorResponse::new(
                        error_codes::CONTRACT_NOT_FOUND,
                        "Contract not found at the configured address",
                    ),
                )
            } else {
                warn!("Storage error during discovery: {}", storage_err);
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    ApiErrorResponse::new(
                        error_codes::RPC_UNAVAILABLE,
                        "Upstream RPC is unavailable",
                    ),
                )
            }
        }
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
    /// Block hash to query state at. Ensures consistent reads across
    /// paginated requests. Leave empty on first request (server uses
    /// current head). On pagination, use the value from previous response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_ref: Option<Felt>,
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
    /// Block hash pinning all reads in this response. Pass back as
    /// `block_ref` in subsequent requests for consistency.
    pub block_ref: Felt,
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
    /// Block hash pinning all reads in this response. Pass back as
    /// `block_ref` in subsequent requests for consistency.
    pub block_ref: Felt,
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
    /// Block hash pinning the reads in this response.
    pub block_ref: Felt,
    /// Whether the sender has a public key registered on-chain.
    pub sender_registered: bool,
    /// Whether the channel from sender to recipient exists.
    pub channel_exists: bool,
    /// Whether the token subchannel exists within the channel.
    pub subchannel_exists: bool,
}

/// Well-known error codes.
pub mod error_codes {
    pub const INVALID_REQUEST: &str = "INVALID_REQUEST";
    pub const DECRYPTION_FAILED: &str = "DECRYPTION_FAILED";
    pub const BLOCK_REORGED: &str = "BLOCK_REORGED";
    pub const SERVICE_UNAVAILABLE: &str = "SERVICE_UNAVAILABLE";
    pub const CONTRACT_NOT_FOUND: &str = "CONTRACT_NOT_FOUND";
    pub const RPC_UNAVAILABLE: &str = "RPC_UNAVAILABLE";
    pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";
}
