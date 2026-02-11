//! Axum API server for the discovery service.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use discovery_core::storage_backend::StorageBackend;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tracing::info;

use crate::chain_state::{ChainHead, ChainState};

/// Configuration for the API server.
#[derive(Debug, Clone)]
pub struct ApiServerConfig {
    /// Host and port to bind to (e.g., "127.0.0.1:8080").
    pub api_host: String,
    /// Maximum lag in seconds before health check returns unhealthy.
    pub health_max_lag_secs: u64,
}

impl Default for ApiServerConfig {
    fn default() -> Self {
        Self {
            api_host: "127.0.0.1:8080".to_string(),
            health_max_lag_secs: 5,
        }
    }
}

/// API server for the discovery service.
pub struct ApiServer<B> {
    rx_shutdown: broadcast::Receiver<()>,
    config: ApiServerConfig,
    backend: B,
}

impl<B> ApiServer<B>
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
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
        });

        let app = Router::new()
            .route("/health", get(health_handler::<B>))
            .with_state(app_state);

        let listener = TcpListener::bind(&self.config.api_host)
            .await
            .map_err(|e| ApiServerError::Bind(e.to_string()))?;

        info!("API server listening on {}", self.config.api_host);

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
struct AppState<B> {
    backend: B,
    health_max_lag_secs: u64,
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
