//! API server with health endpoint for Docker health checks.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use thiserror::Error;
use tokio::sync::broadcast;
use tracing::{error, info};

use crate::store::{SqliteStore, Store};

/// Default maximum lag threshold for health check (5 seconds).
const DEFAULT_HEALTH_MAX_LAG_SECS: u64 = 5;

/// Default API server bind address.
const DEFAULT_API_HOST: &str = "127.0.0.1:8080";

/// Errors that can occur during API server operation.
#[derive(Debug, Error)]
pub enum ApiServerError {
    /// Failed to bind to address.
    #[error("Failed to bind to {0}: {1}")]
    Bind(String, std::io::Error),
    /// Server error.
    #[error("Server error: {0}")]
    Server(#[from] std::io::Error),
}

/// API server configuration.
pub struct ApiServerConfig {
    /// Address to bind the HTTP server to (e.g., "127.0.0.1:8080").
    pub api_host: String,
    /// Maximum acceptable lag in seconds for health check.
    pub health_max_lag_secs: u64,
}

impl Default for ApiServerConfig {
    fn default() -> Self {
        Self {
            api_host: DEFAULT_API_HOST.to_string(),
            health_max_lag_secs: DEFAULT_HEALTH_MAX_LAG_SECS,
        }
    }
}

/// Shared application state for request handlers.
struct AppState {
    store: SqliteStore,
    config: ApiServerConfig,
}

/// Health check response.
#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    chain_head: Option<ChainHead>,
    indexed_state: Option<IndexedStateInfo>,
    lag_secs: u64,
}

/// Chain head info.
#[derive(Serialize)]
struct ChainHead {
    block_number: u64,
    block_hash: String,
    timestamp: u64,
}

/// Indexed state info.
#[derive(Serialize)]
struct IndexedStateInfo {
    block_number: u64,
    block_hash: String,
}

/// API server that exposes health endpoint.
pub struct ApiServer {
    config: ApiServerConfig,
    db_path: String,
    rx_shutdown: broadcast::Receiver<()>,
}

impl ApiServer {
    /// Create a new API server instance.
    pub fn new(
        config: ApiServerConfig,
        db_path: String,
        rx_shutdown: broadcast::Receiver<()>,
    ) -> Self {
        Self {
            config,
            db_path,
            rx_shutdown,
        }
    }

    /// Run the API server until shutdown signal is received.
    pub async fn run(self) -> Result<(), ()> {
        self.run_inner().await.map_err(|e| {
            error!("API server error: {}", e);
        })
    }

    async fn run_inner(mut self) -> Result<(), ApiServerError> {
        let api_host = self.config.api_host.clone();
        info!("API server starting on {}", api_host);

        let store = SqliteStore::reader(&self.db_path);
        let state = Arc::new(AppState {
            store,
            config: self.config,
        });

        let app = Router::new()
            .route("/health", get(health))
            .with_state(state);

        let listener = tokio::net::TcpListener::bind(&api_host)
            .await
            .map_err(|e| ApiServerError::Bind(api_host.clone(), e))?;

        info!("API server listening on {}", api_host);

        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = self.rx_shutdown.recv().await;
                info!("API server received shutdown signal");
            })
            .await?;

        info!("API server stopped");
        Ok(())
    }
}

/// Health endpoint handler.
async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs();

    let mut conn = match state.store.acquire().await {
        Ok(conn) => conn,
        Err(e) => {
            error!(
                "Failed to acquire database connection for health check: {}",
                e
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(HealthResponse {
                    status: "UNHEALTHY",
                    chain_head: None,
                    indexed_state: None,
                    lag_secs: 0,
                }),
            );
        }
    };

    let head = match conn.get_head().await {
        Ok(head) => head,
        Err(e) => {
            error!("Failed to get head for health check: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(HealthResponse {
                    status: "UNHEALTHY",
                    chain_head: None,
                    indexed_state: None,
                    lag_secs: 0,
                }),
            );
        }
    };

    let indexed_state = match conn.get_indexed_state().await {
        Ok(state) => state.map(|s| IndexedStateInfo {
            block_number: s.block_height,
            block_hash: format!("{:#066x}", s.block_hash),
        }),
        Err(e) => {
            error!("Failed to get indexed state for health check: {}", e);
            None
        }
    };

    let (status, lag_secs, chain_head) = match head {
        Some(h) => {
            let lag = now_secs.saturating_sub(h.timestamp);
            let status = if lag <= state.config.health_max_lag_secs {
                "OK"
            } else {
                "UNHEALTHY"
            };
            let chain_head = ChainHead {
                block_number: h.block_number,
                block_hash: h.block_hash,
                timestamp: h.timestamp,
            };
            (status, lag, Some(chain_head))
        }
        // No head yet means service is still initializing
        None => ("UNHEALTHY", now_secs, None),
    };

    let status_code = if status == "OK" {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (
        status_code,
        Json(HealthResponse {
            status,
            chain_head,
            indexed_state,
            lag_secs,
        }),
    )
}
