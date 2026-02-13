//! API route handlers.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use crate::api::types::HealthResponse;
use crate::api::AppState;
use crate::chain_state::ChainState;

/// Handler for GET /health.
pub async fn health_handler<B>(State(state): State<Arc<AppState<B>>>) -> impl IntoResponse
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
