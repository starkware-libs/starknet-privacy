//! Axum API server for the discovery service.

pub mod handlers;
pub mod types;
pub mod validators;

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::Router;
use discovery_core::storage_backend::StorageBackend;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::timeout::TimeoutLayer;
use tracing::info;

use crate::chain_state::ChainState;
use crate::config::{ApiServerConfig, ValidationLimits};
use crate::public_key_cache::PublicKeyCache;

pub use handlers::{
    health_handler, incoming_sync_handler, outgoing_sync_handler, preflight_check_handler,
};
pub use types::{
    ApiErrorBody, ApiErrorResponse, HealthResponse, IncomingSyncRequest, IncomingSyncResponse,
    OutgoingSyncRequest, OutgoingSyncResponse, PreflightCheckRequest, PreflightCheckResponse,
    SyncRequestBase,
};

/// API server for the discovery service.
pub struct ApiServer<B> {
    rx_shutdown: broadcast::Receiver<()>,
    config: ApiServerConfig,
    backend: B,
}

/// Errors that can occur in the API server.
#[derive(Debug, thiserror::Error)]
pub enum ApiServerError {
    #[error("failed to bind to address: {0}")]
    Bind(String),
    #[error("server error: {0}")]
    Serve(String),
}

/// Shared state for the API handlers.
pub struct AppState<B> {
    pub backend: B,
    pub health_max_lag_secs: u64,
    pub validation_limits: ValidationLimits,
    pub public_key_cache: PublicKeyCache,
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
            public_key_cache: PublicKeyCache::new(
                self.config.validation_limits.public_key_cache_capacity,
            ),
            validation_limits: self.config.validation_limits.clone(),
        });

        // TODO: Add TLS termination (spec 5.1)
        let app = Router::new()
            .route("/health", get(health_handler::<B>))
            .route("/v1/sync/incoming_state", post(incoming_sync_handler::<B>))
            .route("/v1/sync/outgoing_state", post(outgoing_sync_handler::<B>))
            .route(
                "/v1/sync/preflight_check",
                post(preflight_check_handler::<B>),
            )
            .layer(CorsLayer::permissive())
            .layer(DefaultBodyLimit::max(
                self.config.validation_limits.max_request_body_bytes,
            ))
            .layer(TimeoutLayer::with_status_code(
                axum::http::StatusCode::REQUEST_TIMEOUT,
                self.config.request_timeout,
            ))
            .with_state(app_state);

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
