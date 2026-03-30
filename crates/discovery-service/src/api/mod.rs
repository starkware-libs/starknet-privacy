//! Axum API server for the discovery service.

pub mod handlers;
pub mod types;
pub mod validators;

use std::fs::File;
use std::io::BufReader;
use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::Router;
use discovery_core::events_backend::RawEventAccess;
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
    health_handler, history_handler, incoming_sync_handler, outgoing_sync_handler,
    preflight_check_handler,
};
pub use types::{
    ApiErrorBody, ApiErrorResponse, HealthResponse, HistoryRequest, HistoryResponse,
    IncomingSyncRequest, IncomingSyncResponse, OutgoingSyncRequest, OutgoingSyncResponse,
    PreflightCheckRequest, PreflightCheckResponse, SyncRequestBase,
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
    #[error("TLS configuration error: {0}")]
    Tls(String),
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
    B::Snapshot: RawEventAccess + Clone + Send + Sync + 'static,
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

        let app = Router::new()
            .route("/health", get(health_handler::<B>))
            .route("/v1/sync/incoming_state", post(incoming_sync_handler::<B>))
            .route("/v1/sync/outgoing_state", post(outgoing_sync_handler::<B>))
            .route(
                "/v1/sync/preflight_check",
                post(preflight_check_handler::<B>),
            )
            .route("/v1/history", post(history_handler::<B>))
            .layer(CorsLayer::permissive())
            .layer(DefaultBodyLimit::max(
                self.config.validation_limits.max_request_body_bytes,
            ))
            .layer(TimeoutLayer::with_status_code(
                axum::http::StatusCode::REQUEST_TIMEOUT,
                self.config.request_timeout,
            ))
            .with_state(app_state);

        let tcp_listener = TcpListener::bind(&self.config.host)
            .await
            .map_err(|e| ApiServerError::Bind(e.to_string()))?;

        let mut rx_shutdown = self.rx_shutdown.resubscribe();
        let shutdown_signal = async move {
            let _ = rx_shutdown.recv().await;
            info!("API server shutting down");
        };

        if let Some(tls) = &self.config.tls {
            // Both aws-lc-rs and ring features are enabled transitively, so rustls
            // cannot auto-detect a provider. Install ring explicitly.
            let _ = rustls::crypto::ring::default_provider().install_default();

            let certs = rustls_pemfile::certs(&mut BufReader::new(
                File::open(&tls.cert_path)
                    .map_err(|e| ApiServerError::Tls(format!("open cert: {e}")))?,
            ))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| ApiServerError::Tls(format!("parse certs: {e}")))?;

            if certs.is_empty() {
                return Err(ApiServerError::Tls(
                    "certificate file contains no certificates".into(),
                ));
            }

            let key = rustls_pemfile::private_key(&mut BufReader::new(
                File::open(&tls.key_path)
                    .map_err(|e| ApiServerError::Tls(format!("open key: {e}")))?,
            ))
            .map_err(|e| ApiServerError::Tls(format!("parse key: {e}")))?
            .ok_or_else(|| ApiServerError::Tls("no private key found".into()))?;

            let mut server_config = rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(certs, key)
                .map_err(|e| ApiServerError::Tls(e.to_string()))?;
            server_config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

            let tls_acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config));
            let tls_listener = tls_listener::builder(tls_acceptor)
                .handshake_timeout(tls.handshake_timeout)
                .listen(tcp_listener);

            info!("API server listening on {} (TLS)", self.config.host);
            axum::serve(tls_listener, app)
                .with_graceful_shutdown(shutdown_signal)
                .await
                .map_err(|e| ApiServerError::Serve(e.to_string()))?;
        } else {
            info!("API server listening on {}", self.config.host);
            axum::serve(tcp_listener, app)
                .with_graceful_shutdown(shutdown_signal)
                .await
                .map_err(|e| ApiServerError::Serve(e.to_string()))?;
        }

        info!("API server has shut down");
        Ok(())
    }
}
