//! Shared API types: health response, error response, error codes.

use axum::http::StatusCode;
use discovery_core::discovery::DiscoveryError;
use serde::{Deserialize, Serialize};
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
#[allow(dead_code)] // Used by endpoint handlers in slices 15a–15c.
pub(crate) fn discovery_error_to_response(error: DiscoveryError) -> (StatusCode, ApiErrorResponse) {
    match error {
        DiscoveryError::Storage(storage_err) => {
            warn!("Storage error during discovery: {}", storage_err);
            (
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorResponse::new(error_codes::RPC_UNAVAILABLE, "Upstream RPC is unavailable"),
            )
        }
        DiscoveryError::Decryption { index, source } => (
            StatusCode::BAD_REQUEST,
            ApiErrorResponse::with_details(
                error_codes::DECRYPTION_FAILED,
                format!("Decryption failed at index {}: {}", index, source),
                serde_json::json!({ "index": index }),
            ),
        ),
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
    }
}

/// Well-known error codes.
pub mod error_codes {
    pub const INVALID_REQUEST: &str = "INVALID_REQUEST";
    pub const DECRYPTION_FAILED: &str = "DECRYPTION_FAILED";
    pub const BLOCK_REORGED: &str = "BLOCK_REORGED";
    pub const SERVICE_UNAVAILABLE: &str = "SERVICE_UNAVAILABLE";
    pub const RPC_UNAVAILABLE: &str = "RPC_UNAVAILABLE";
    pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";
}
