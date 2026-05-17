//! HTTP access-log middleware.
//!
//! Emits exactly one structured log line per request at response time with
//! `method`, `path`, `status`, and `latency_ms` fields. `path` is the matched
//! route template (from [`MatchedPath`]) when available; otherwise it is the
//! fixed literal [`UNMATCHED_PATH`] (not the raw URI path) to prevent log spamming.
//!
//! `/health` is logged at `DEBUG` so readiness probes don't flood steady-state
//! `INFO` output; every other route logs at `INFO`.

use std::time::Instant;

use axum::extract::{MatchedPath, Request};
use axum::middleware::Next;
use axum::response::Response;
use tower_http::request_id::RequestId;
use tracing::{debug, info};

/// Path treated as low-signal for access logs (readiness probes).
const DEBUG_PATH: &str = "/health";

pub async fn access_log(req: Request, next: Next) -> Response {
    let start = Instant::now();
    let method = req.method().clone();
    let path = req
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| matched.as_str().to_owned())
        .unwrap_or_else(|| "<unmatched>".to_owned());
    // Pulled explicitly so the id appears at the top level of the JSON line.
    // The parent `http_request` span carries the same field, but the JSON
    // formatter nests span fields under "spans" rather than the event root.
    let request_id = req
        .extensions()
        .get::<RequestId>()
        .and_then(|id| id.header_value().to_str().ok())
        .map(|s| s.to_owned())
        .unwrap_or_default();

    let response = next.run(req).await;

    let status = response.status().as_u16();
    let latency_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);

    if path == DEBUG_PATH {
        debug!(
            method = %method,
            path = %path,
            status,
            latency_ms,
            request_id = %request_id,
            "http_access"
        );
    } else {
        info!(
            method = %method,
            path = %path,
            status,
            latency_ms,
            request_id = %request_id,
            "http_access"
        );
    }

    response
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::{Arc, Mutex};

    use axum::body::Body;
    use axum::http::{HeaderName, Request as HttpRequest, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;
    use tower_http::request_id::{MakeRequestUuid, SetRequestIdLayer};
    use tracing::Level;
    use tracing_subscriber::fmt::MakeWriter;

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

    fn router() -> Router {
        Router::new()
            .route("/health", get(|| async { "ok" }))
            .route("/v1/echo", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(access_log))
            .layer(SetRequestIdLayer::new(
                HeaderName::from_static("x-request-id"),
                MakeRequestUuid,
            ))
            .layer(axum::middleware::from_fn(
                super::super::sanitize_inbound_request_id,
            ))
    }

    async fn capture_logs<F>(test_body: F) -> String
    where
        F: std::future::Future<Output = ()>,
    {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(CapturingWriter(buf.clone()))
            .with_max_level(Level::DEBUG)
            .with_ansi(false)
            .json()
            .finish();
        let dispatch = tracing::Dispatch::new(subscriber);
        let _guard = tracing::dispatcher::set_default(&dispatch);

        test_body.await;

        let output = buf.lock().unwrap().clone();
        String::from_utf8(output).expect("log output is utf8")
    }

    #[tokio::test]
    async fn logs_matched_path_method_status_latency() {
        let logs = capture_logs(async {
            let response = router()
                .oneshot(
                    HttpRequest::builder()
                        .method("GET")
                        .uri("/v1/echo")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        })
        .await;

        assert!(
            logs.contains(r#""level":"INFO""#),
            "level INFO missing: {logs}"
        );
        assert!(logs.contains(r#""method":"GET""#), "method missing: {logs}");
        assert!(
            logs.contains(r#""path":"/v1/echo""#),
            "matched path missing: {logs}"
        );
        assert!(logs.contains(r#""status":200"#), "status missing: {logs}");
        assert!(logs.contains(r#""latency_ms":"#), "latency missing: {logs}");
        assert!(
            logs.contains(r#""request_id":""#) && !logs.contains(r#""request_id":"""#),
            "non-empty request_id missing: {logs}"
        );
        assert_eq!(
            logs.lines().count(),
            1,
            "expected exactly one log line: {logs}"
        );
    }

    #[tokio::test]
    async fn unmatched_path_logs_fixed_placeholder_not_raw_uri() {
        let attacker_path = format!("/{}", "x".repeat(10_000));

        let logs = capture_logs(async {
            let response = router()
                .oneshot(
                    HttpRequest::builder()
                        .method("GET")
                        .uri(&attacker_path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        })
        .await;

        assert!(
            logs.contains(r#""path":"<unmatched>""#),
            "expected fixed unmatched placeholder: {logs}"
        );
        assert!(
            !logs.contains(&attacker_path),
            "raw URI path must not appear in logs: {logs}"
        );
        assert!(
            !logs.contains("xxxxx"),
            "raw URI prefix must not appear in logs: {logs}"
        );
    }

    #[tokio::test]
    async fn echoes_acceptable_inbound_request_id_in_access_log() {
        let inbound_id = "test-request-abc";
        let logs = capture_logs(async {
            router()
                .oneshot(
                    HttpRequest::builder()
                        .method("GET")
                        .uri("/v1/echo")
                        .header("x-request-id", inbound_id)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
        })
        .await;

        assert!(
            logs.contains(&format!(r#""request_id":"{inbound_id}""#)),
            "expected inbound request id in log: {logs}"
        );
    }

    #[tokio::test]
    async fn drops_oversized_inbound_request_id() {
        let oversized = "a".repeat(super::super::MAX_INBOUND_REQUEST_ID_LEN + 1);
        let logs = capture_logs(async {
            router()
                .oneshot(
                    HttpRequest::builder()
                        .method("GET")
                        .uri("/v1/echo")
                        .header("x-request-id", &oversized)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
        })
        .await;

        assert!(
            !logs.contains(&oversized),
            "oversized inbound id must not be echoed: {logs}"
        );
        assert!(
            logs.contains(r#""request_id":""#) && !logs.contains(r#""request_id":"""#),
            "expected server-generated fallback id in log: {logs}"
        );
    }

    #[tokio::test]
    async fn drops_inbound_request_id_with_non_printable_bytes() {
        // HeaderValue admits HT (0x09) but our policy requires `0x20`–`0x7E`,
        // so a value containing a tab must be rejected and replaced.
        let inbound_id = "ok\tbad";
        let logs = capture_logs(async {
            router()
                .oneshot(
                    HttpRequest::builder()
                        .method("GET")
                        .uri("/v1/echo")
                        .header(
                            "x-request-id",
                            axum::http::HeaderValue::from_bytes(inbound_id.as_bytes()).unwrap(),
                        )
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
        })
        .await;

        assert!(
            !logs.contains(inbound_id),
            "control-byte inbound id must not be echoed: {logs}"
        );
        assert!(
            logs.contains(r#""request_id":""#) && !logs.contains(r#""request_id":"""#),
            "expected server-generated fallback id in log: {logs}"
        );
    }

    #[tokio::test]
    async fn health_logs_at_debug_level() {
        let logs = capture_logs(async {
            router()
                .oneshot(
                    HttpRequest::builder()
                        .method("GET")
                        .uri("/health")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
        })
        .await;

        assert!(
            logs.contains(r#""level":"DEBUG""#),
            "expected DEBUG level: {logs}"
        );
        assert!(
            logs.contains(r#""path":"/health""#),
            "health path missing: {logs}"
        );
    }
}
