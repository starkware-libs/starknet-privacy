//! Handler for POST /v1/discovery/preflight.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use discovery_core::privacy_pool::types::SecretFelt;
use discovery_core::storage_backend::StorageBackend;
use tracing::warn;

use crate::api_server::{discovery_error_to_response, error_codes, ApiErrorResponse, AppState};
use crate::chain_state::ChainState;

use super::types::{PreflightRequest, PreflightResponse};

/// Handler for POST /v1/discovery/preflight.
pub async fn preflight_handler<B>(
    State(state): State<Arc<AppState<B>>>,
    Json(request): Json<PreflightRequest>,
) -> impl IntoResponse
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: Clone + Send + Sync + 'static,
{
    match preflight_impl(&state, request).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err((status, error)) => (status, Json(error)).into_response(),
    }
}

async fn preflight_impl<B>(
    state: &AppState<B>,
    request: PreflightRequest,
) -> Result<PreflightResponse, (StatusCode, ApiErrorResponse)>
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: Clone + Send + Sync + 'static,
{
    let head = state.backend.get_head().await.ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorResponse::new(
                error_codes::SERVICE_UNAVAILABLE,
                "No indexed head available yet",
            ),
        )
    })?;

    let snapshot = state
        .backend
        .snapshot(Some(starknet_core::types::BlockId::Hash(head.block_hash)))
        .await
        .map_err(|e| {
            warn!("Failed to create snapshot: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorResponse::new(
                    error_codes::INTERNAL_ERROR,
                    format!("Failed to create snapshot: {}", e),
                ),
            )
        })?;

    let viewing_key = SecretFelt::new(request.viewing_key);

    let output = discovery_core::discovery::preflight::preflight(
        &snapshot,
        request.sender_address,
        &viewing_key,
        request.recipient,
        request.token,
    )
    .await
    .map_err(discovery_error_to_response)?;

    Ok(PreflightResponse {
        block_ref: head.block_hash,
        sender_registered: output.sender_registered,
        channel_exists: output.channel_exists,
        subchannel_exists: output.subchannel_exists,
    })
}
