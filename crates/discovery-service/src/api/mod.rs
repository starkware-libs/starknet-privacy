//! Axum API server for the discovery service.

mod access_log;
pub mod block_id_serde;
pub mod handlers;
mod request_span;
pub mod types;
pub mod validators;

use std::fs::File;
use std::io::BufReader;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Request};
use axum::http::HeaderName;
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use discovery_core::events_backend::RawEventAccess;
use discovery_core::storage_backend::StorageBackend;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::timeout::TimeoutLayer;
use tracing::info;

use tower::Layer;
use tower_ohttp::{OhttpGateway, OhttpLayer};

use crate::chain_state::ChainState;
use crate::config::OhttpConfig;
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
    ohttp_gateway: Option<Arc<OhttpGateway>>,
    ohttp_config: OhttpConfig,
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
    pub fn new(
        config: ApiServerConfig,
        rx_shutdown: broadcast::Receiver<()>,
        backend: B,
        ohttp_gateway: Option<Arc<OhttpGateway>>,
        ohttp_config: OhttpConfig,
    ) -> Self {
        Self {
            rx_shutdown,
            config,
            backend,
            ohttp_gateway,
            ohttp_config,
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

        let api_router = Router::new()
            .route("/health", get(health_handler::<B>))
            .route("/v1/sync/incoming_state", post(incoming_sync_handler::<B>))
            .route("/v1/sync/outgoing_state", post(outgoing_sync_handler::<B>))
            .route(
                "/v1/sync/preflight_check",
                post(preflight_check_handler::<B>),
            )
            .route("/v1/history", post(history_handler::<B>))
            .with_state(app_state);

        let request_id_header = HeaderName::from_static("x-request-id");

        // Conditionally add OHTTP envelope encryption.
        // The OhttpLayer wraps a clone of the API router and is installed as
        // the fallback service. Unmatched paths (e.g. `POST /` from a relay)
        // hit the fallback, which decapsulates the OHTTP envelope and re-routes
        // the inner request through the cloned router. Matched plaintext
        // requests bypass OHTTP entirely.
        //
        // The inner clone has its own `SetRequestIdLayer` (and an unconditional
        // strip of any inbound id) so decapsulated requests still get a
        // per-envelope server-generated UUID bound to their handlers. There is
        // no `PropagateRequestIdLayer` on the inner clone — the inner id is
        // never echoed back to the client, preserving the unlinkability that
        // OHTTP exists to provide. The outer response carries the *outer*
        // request id assigned by the layers below.
        let app = if let Some(gateway) = &self.ohttp_gateway {
            let ohttp_layer = OhttpLayer::new(
                gateway.clone(),
                self.config.validation_limits.max_request_body_bytes,
                self.ohttp_config.key_cache_max_age_secs,
                axum::body::Body::new,
            );
            let inner_router = api_router
                .clone()
                .layer(SetRequestIdLayer::new(
                    request_id_header.clone(),
                    MakeRequestUuid,
                ))
                .layer(axum::middleware::from_fn(strip_inbound_request_id));
            let ohttp_service = ohttp_layer.layer(inner_router);
            info!("OHTTP envelope encryption enabled");
            api_router.fallback_service(ohttp_service)
        } else {
            api_router
        };

        // Layer ordering: in axum, the LAST `.layer()` call is the OUTERMOST.
        // The sanitize middleware runs first to drop any client-supplied
        // `x-request-id` that fails validation. `SetRequestIdLayer` then
        // reuses a valid inbound id or generates a fresh server-side UUID
        // when none remains. Downstream layers (span binding, access log,
        // handlers) read that id, and `PropagateRequestIdLayer` echoes it on
        // the response.
        let app = app
            .layer(CorsLayer::permissive())
            .layer(DefaultBodyLimit::max(
                self.config.validation_limits.max_request_body_bytes,
            ))
            .layer(TimeoutLayer::with_status_code(
                axum::http::StatusCode::REQUEST_TIMEOUT,
                self.config.request_timeout,
            ))
            .layer(axum::middleware::from_fn(access_log::access_log))
            .layer(axum::middleware::from_fn(request_span::request_span))
            .layer(PropagateRequestIdLayer::new(request_id_header.clone()))
            .layer(SetRequestIdLayer::new(request_id_header, MakeRequestUuid))
            .layer(axum::middleware::from_fn(sanitize_inbound_request_id));

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

/// Maximum accepted length of a client-supplied `x-request-id`, sized to
/// match the canonical UUID v4 string the server generates as a fallback
/// (8-4-4-4-12 with hyphens = 36 bytes). Anything longer would let callers
/// inflate log lines arbitrarily.
const MAX_INBOUND_REQUEST_ID_LEN: usize = 36;

/// Drops a client-supplied `x-request-id` unless it is short, printable
/// ASCII. Keeping the inbound value lets callers correlate their own logs
/// with ours; rejecting hostile values (over-long, non-printable, control
/// bytes) keeps the id safe to embed in log lines and JSON error bodies.
/// When the header is dropped, the downstream `SetRequestIdLayer` falls back
/// to a fresh server-generated UUID.
pub(crate) async fn sanitize_inbound_request_id(mut req: Request, next: Next) -> Response {
    let keep = req
        .headers()
        .get("x-request-id")
        .is_some_and(is_acceptable_request_id);
    if !keep {
        req.headers_mut().remove("x-request-id");
    }
    next.run(req).await
}

/// Unconditionally drops any inbound `x-request-id`. Used on the
/// OHTTP-decapsulated inner router: honoring a client-supplied id inside an
/// encrypted envelope would leak a stable fingerprint and undermine the
/// unlinkability OHTTP exists to provide, so the downstream
/// `SetRequestIdLayer` always assigns a fresh per-envelope UUID.
pub(crate) async fn strip_inbound_request_id(mut req: Request, next: Next) -> Response {
    req.headers_mut().remove("x-request-id");
    next.run(req).await
}

fn is_acceptable_request_id(value: &axum::http::HeaderValue) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_INBOUND_REQUEST_ID_LEN
        && bytes.iter().all(|&byte| (0x20..=0x7E).contains(&byte))
}

#[cfg(test)]
mod ohttp_layer_tests {
    use axum::body::Body;
    use axum::http::{header, HeaderName, Request, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::post;
    use axum::{Extension, Router};
    use http_body_util::BodyExt;
    use tower::{Layer, ServiceExt};
    use tower_http::request_id::{MakeRequestUuid, RequestId, SetRequestIdLayer};
    use tower_ohttp::test_utils::{
        decapsulate_bhttp_response, encapsulate_bhttp_request, test_gateway,
    };
    use tower_ohttp::OhttpLayer;

    const BODY_LIMIT: usize = 102_400;
    const KEY_CACHE_SECS: u64 = 3600;

    async fn echo_handler(body: axum::body::Bytes) -> impl IntoResponse {
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            body,
        )
    }

    /// Echoes back the bound `RequestId` (or the literal `none` when no id is
    /// on the request) so OHTTP tests can verify that the inner clone really
    /// did assign a per-envelope id.
    async fn request_id_handler(request_id: Option<Extension<RequestId>>) -> impl IntoResponse {
        let value = request_id
            .as_deref()
            .and_then(|id| id.header_value().to_str().ok())
            .unwrap_or("none")
            .to_owned();
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/plain")],
            value,
        )
    }

    fn test_router() -> Router {
        let gateway = test_gateway();
        let ohttp_layer = OhttpLayer::new(gateway, BODY_LIMIT, KEY_CACHE_SECS, Body::new);
        let api_router = Router::new()
            .route("/v1/echo", post(echo_handler))
            .route("/v1/request-id", post(request_id_handler));
        // Mirror the production layering: the inner clone gets its own
        // `SetRequestIdLayer` (after an unconditional strip) so decapsulated
        // requests have a `RequestId` extension bound to them.
        let inner_router = api_router
            .clone()
            .layer(SetRequestIdLayer::new(
                HeaderName::from_static("x-request-id"),
                MakeRequestUuid,
            ))
            .layer(axum::middleware::from_fn(super::strip_inbound_request_id));
        let ohttp_service = ohttp_layer.layer(inner_router);
        api_router.fallback_service(ohttp_service)
    }

    #[tokio::test]
    async fn ohttp_round_trip_through_axum_router() {
        let app = test_router();
        let gateway = test_gateway();

        let json_body = br#"{"viewing_key":"0xabc"}"#;
        let (encapsulated, client_response) =
            encapsulate_bhttp_request(&gateway, "POST", "/v1/echo", json_body, &[]);

        let request = Request::builder()
            .method("POST")
            .uri("/")
            .header(header::CONTENT_TYPE, "message/ohttp-req")
            .body(Body::from(encapsulated))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "message/ohttp-res"
        );

        let encrypted_body = response.into_body().collect().await.unwrap().to_bytes();
        let decapsulated = decapsulate_bhttp_response(client_response, &encrypted_body);
        assert_eq!(decapsulated.status, 200);
        assert_eq!(decapsulated.body, json_body);
    }

    #[tokio::test]
    async fn ohttp_inner_request_gets_server_generated_request_id() {
        let app = test_router();
        let gateway = test_gateway();

        // Send an inbound `x-request-id` inside the envelope; the inner
        // router must drop it and assign its own UUID instead, so the
        // decapsulated body should NOT contain the client-supplied value.
        let client_supplied = b"client-supplied-id";
        let (encapsulated, client_response) = encapsulate_bhttp_request(
            &gateway,
            "POST",
            "/v1/request-id",
            b"",
            &[("x-request-id", client_supplied.as_slice())],
        );

        let request = Request::builder()
            .method("POST")
            .uri("/")
            .header(header::CONTENT_TYPE, "message/ohttp-req")
            .body(Body::from(encapsulated))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let encrypted_body = response.into_body().collect().await.unwrap().to_bytes();
        let decapsulated = decapsulate_bhttp_response(client_response, &encrypted_body);
        assert_eq!(decapsulated.status, 200);

        let body = std::str::from_utf8(&decapsulated.body).unwrap();
        assert_ne!(body, "none", "inner handler did not see a RequestId");
        assert!(
            !body.contains(std::str::from_utf8(client_supplied).unwrap()),
            "client-supplied inner id leaked into handler: {body}"
        );
    }

    #[tokio::test]
    async fn plaintext_request_passes_through() {
        let app = test_router();

        let request = Request::builder()
            .method("POST")
            .uri("/v1/echo")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(br#"{"hello":"world"}"#.to_vec()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body.as_ref(), br#"{"hello":"world"}"#);
    }
}
