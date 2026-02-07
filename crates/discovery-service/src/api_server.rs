//! Axum API server for the discovery service.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use discovery_core::storage_backend::StorageBackend;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tracing::{info, warn};

use crate::chain_state::{ChainHead, ChainState};
use crate::config::{ApiServerConfig, ValidationLimits};
use crate::incoming_sync::incoming_sync_handler;
use crate::outgoing_sync::outgoing_sync_handler;
use crate::preflight::preflight_handler;

/// API server for the discovery service.
pub struct ApiServer<B> {
    rx_shutdown: broadcast::Receiver<()>,
    config: ApiServerConfig,
    backend: B,
}

impl<B> ApiServer<B>
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: Clone + Send + Sync + 'static,
{
    /// Creates a new API server.
    pub fn new(config: ApiServerConfig, rx_shutdown: broadcast::Receiver<()>, backend: B) -> Self {
        Self {
            rx_shutdown,
            config,
            backend,
        }
    }

    /// Runs the API server until shutdown is signaled.
    pub async fn run(&mut self) -> Result<(), ApiServerError> {
        let app_state = Arc::new(AppState {
            backend: self.backend.clone(),
            health_max_lag_secs: self.config.health_max_lag_secs,
            validation_limits: self.config.validation_limits.clone(),
        });

        // TODO: Add TLS termination (spec 5.1)
        let app = Router::new()
            .route("/health", get(health_handler::<B>))
            .route("/v1/sync/incoming_state", post(incoming_sync_handler::<B>))
            .route("/v1/sync/outgoing_state", post(outgoing_sync_handler::<B>))
            .route("/v1/discovery/preflight", post(preflight_handler::<B>))
            // TODO: Implement POST /v1/discovery/history endpoint (spec 6.7)
            .with_state(app_state);

        // TODO(security): Add DefaultBodyLimit layer — current Axum 2MB default is
        //   far larger than needed (~500 bytes for a legitimate request) and allows
        //   cursor-stuffing attacks. Cap at 64KB.
        // TODO(security): Add tower::timeout::TimeoutLayer — without a request
        //   timeout, slow RPC responses can block tokio worker threads indefinitely
        //   (100 reads × 60s RPC timeout = ~100min per request).

        let listener = TcpListener::bind(&self.config.host)
            .await
            .map_err(|e| ApiServerError::Bind(e.to_string()))?;

        info!("API server listening on {}", self.config.host);

        let mut rx_shutdown = self.rx_shutdown.resubscribe();
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx_shutdown.recv().await;
                info!("API server shutting down");
            })
            .await
            .map_err(|e| ApiServerError::Serve(e.to_string()))?;

        info!("API server has shut down");
        Ok(())
    }
}

/// Shared state for the API handlers.
pub struct AppState<B> {
    pub backend: B,
    pub health_max_lag_secs: u64,
    pub validation_limits: ValidationLimits,
}

/// Response for the health endpoint.
#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub chain_head: Option<ChainHead>,
    pub lag_secs: u64,
}

/// Handler for GET /health.
async fn health_handler<B>(State(state): State<Arc<AppState<B>>>) -> impl IntoResponse
where
    B: ChainState + Send + Sync + 'static,
{
    let head = state.backend.get_head().await;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let (status, lag_secs, status_code) = match &head {
        Some(h) => {
            let lag = now.saturating_sub(h.timestamp);
            if lag <= state.health_max_lag_secs {
                ("OK", lag, StatusCode::OK)
            } else {
                ("UNHEALTHY", lag, StatusCode::OK)
            }
        }
        None => ("UNHEALTHY", 0, StatusCode::SERVICE_UNAVAILABLE),
    };

    let response = HealthResponse {
        status: status.to_string(),
        chain_head: head,
        lag_secs,
    };

    (status_code, Json(response))
}

/// Errors that can occur in the API server.
#[derive(Debug, thiserror::Error)]
pub enum ApiServerError {
    #[error("failed to bind to address: {0}")]
    Bind(String),
    #[error("server error: {0}")]
    Serve(String),
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
pub(crate) fn discovery_error_to_response(
    e: discovery_core::DiscoveryError,
) -> (StatusCode, ApiErrorResponse) {
    use discovery_core::DiscoveryError;

    match e {
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

/// Error codes for the API endpoints.
pub mod error_codes {
    pub const INVALID_REQUEST: &str = "INVALID_REQUEST";
    pub const DECRYPTION_FAILED: &str = "DECRYPTION_FAILED";
    pub const BLOCK_REORGED: &str = "BLOCK_REORGED";
    pub const SERVICE_UNAVAILABLE: &str = "SERVICE_UNAVAILABLE";
    pub const RPC_UNAVAILABLE: &str = "RPC_UNAVAILABLE";
    pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";
}
