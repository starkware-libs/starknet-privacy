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
