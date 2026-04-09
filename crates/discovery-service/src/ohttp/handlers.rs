//! OHTTP-specific HTTP handlers.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;

use crate::ohttp::gateway::OhttpGateway;

/// Handler for `GET /ohttp-keys`.
///
/// Returns the server's OHTTP key configuration in the
/// `application/ohttp-keys` binary format (RFC 9458 §3).
pub async fn ohttp_keys_handler(State(gateway): State<Arc<OhttpGateway>>) -> impl IntoResponse {
    (
        StatusCode::OK,
        [
            ("content-type", "application/ohttp-keys"),
            ("cache-control", "public, max-age=3600"),
        ],
        gateway.encoded_config().to_vec(),
    )
}
