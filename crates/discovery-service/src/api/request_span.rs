//! Opens a tracing span bound to the request id for the lifetime of each request.
//!
//! `SetRequestIdLayer` stashes a `RequestId` extension on the request. This
//! middleware reads it and wraps the downstream service in an `http_request`
//! span carrying `request_id`, so every `tracing::*` macro fired inside
//! handlers — including the access-log emitter in [`super::access_log`] —
//! inherits the field automatically.

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use tower_http::request_id::RequestId;
use tracing::Instrument;

pub async fn request_span(req: Request, next: Next) -> Response {
    let request_id = req
        .extensions()
        .get::<RequestId>()
        .and_then(|id| id.header_value().to_str().ok())
        .unwrap_or("")
        .to_owned();

    let span = tracing::info_span!("http_request", request_id = %request_id);
    next.run(req).instrument(span).await
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use axum::body::Body;
    use axum::extract::DefaultBodyLimit;
    use axum::http::{HeaderName, Request as HttpRequest, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;
    use tower_http::cors::CorsLayer;
    use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
    use tower_http::timeout::TimeoutLayer;
    use tracing::Level;
    use tracing_subscriber::fmt::MakeWriter;

    use super::super::{access_log, sanitize_inbound_request_id};

    #[derive(Clone)]
    struct CapturingWriter(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for CapturingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for CapturingWriter {
        type Writer = CapturingWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// Mirrors the production layering in [`super::super::ApiServer::run`] so
    /// the test exercises the same middleware order a real request hits.
    fn router() -> Router {
        let request_id_header = HeaderName::from_static("x-request-id");
        Router::new()
            .route(
                "/v1/log",
                get(|| async {
                    tracing::info!("handler-emitted log");
                    "ok"
                }),
            )
            .layer(CorsLayer::permissive())
            .layer(DefaultBodyLimit::max(1024))
            .layer(TimeoutLayer::with_status_code(
                StatusCode::REQUEST_TIMEOUT,
                Duration::from_secs(5),
            ))
            .layer(axum::middleware::from_fn(access_log::access_log))
            .layer(axum::middleware::from_fn(super::request_span))
            .layer(PropagateRequestIdLayer::new(request_id_header.clone()))
            .layer(SetRequestIdLayer::new(request_id_header, MakeRequestUuid))
            .layer(axum::middleware::from_fn(sanitize_inbound_request_id))
    }

    #[tokio::test]
    async fn handler_log_inherits_request_id_from_span() {
        let inbound_id = "test-span-id-123";

        let buf = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(CapturingWriter(buf.clone()))
            .with_max_level(Level::INFO)
            .with_ansi(false)
            .json()
            .finish();
        let dispatch = tracing::Dispatch::new(subscriber);
        let _guard = tracing::dispatcher::set_default(&dispatch);

        let response = router()
            .oneshot(
                HttpRequest::builder()
                    .method("GET")
                    .uri("/v1/log")
                    .header("x-request-id", inbound_id)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let logs = String::from_utf8(buf.lock().unwrap().clone()).unwrap();

        // Locate the handler-emitted log line specifically (the access-log
        // middleware emits its own line on the same request that also carries
        // the id, so we filter to the one whose `message` is the handler's).
        let handler_log_line = logs
            .lines()
            .find(|line| line.contains(r#""message":"handler-emitted log""#))
            .unwrap_or_else(|| panic!("handler-emitted log line missing: {logs}"));

        // The span field bound by [`request_span`] should appear inside the
        // handler's log line, proving the span context is inherited by
        // `tracing::*` macros fired from within the handler.
        assert!(
            handler_log_line.contains(&format!(r#""request_id":"{inbound_id}""#)),
            "handler log line missing inherited request_id: {handler_log_line}"
        );
    }
}
