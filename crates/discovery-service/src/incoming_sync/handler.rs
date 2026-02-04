//! Handler and supporting logic for POST /v1/discovery/incoming/sync.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use discovery_core::io_budget::IoBudget;
use discovery_core::storage_backend::StorageBackend;
use tracing::warn;

use crate::api_server::{error_codes, ApiErrorResponse, AppState};
use crate::chain_state::ChainState;

use super::types::{IncomingSyncRequest, IncomingSyncResponse};
use super::validation::ValidatedRequest;

/// Handler for POST /v1/discovery/incoming/sync.
pub async fn incoming_sync_handler<B>(
    State(state): State<Arc<AppState<B>>>,
    Json(request): Json<IncomingSyncRequest>,
) -> impl IntoResponse
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: Clone + Send + Sync + 'static,
{
    match incoming_sync_impl(&state, request).await {
        Ok(response) => (
            StatusCode::OK,
            Json(serde_json::to_value(response).unwrap()),
        )
            .into_response(),
        Err((status, error)) => (status, Json(error)).into_response(),
    }
}

async fn incoming_sync_impl<B>(
    state: &AppState<B>,
    request: IncomingSyncRequest,
) -> Result<IncomingSyncResponse, (StatusCode, ApiErrorResponse)>
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: Clone + Send + Sync + 'static,
{
    let validated = ValidatedRequest::from_request(request, &state.backend).await?;

    let snapshot = state
        .backend
        .snapshot(Some(validated.query_block))
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

    let budget = IoBudget::new(validated.max_reads);

    let discovery_output = discovery_core::sync::incoming_state::sync_incoming_state(
        &snapshot,
        validated.recipient_address,
        &validated.decryption_key,
        validated.cursor,
        &budget,
    )
    .await
    .map_err(discovery_error_to_response)?;

    Ok(IncomingSyncResponse {
        block_ref: validated.block_ref,
        channels: discovery_output.channels,
        cursor: discovery_output.cursor,
    })
}

fn discovery_error_to_response(
    e: discovery_core::discovery::DiscoveryError,
) -> (StatusCode, ApiErrorResponse) {
    use discovery_core::discovery::DiscoveryError;

    match e {
        DiscoveryError::Storage(storage_err) => {
            warn!("Storage error during discovery: {}", storage_err);
            (
                StatusCode::SERVICE_UNAVAILABLE,
                ApiErrorResponse::new(error_codes::RPC_UNAVAILABLE, "Upstream RPC is unavailable"),
            )
        }
        DiscoveryError::Decryption { index, source } => (
            StatusCode::BAD_REQUEST,
            ApiErrorResponse::with_details(
                error_codes::INVALID_REQUEST,
                format!("Decryption failed at index {}: {}", index, source),
                serde_json::json!({ "index": index }),
            ),
        ),
        DiscoveryError::TaskPanicked(msg) => {
            warn!("Discovery task panicked: {}", msg);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiErrorResponse::new(error_codes::INTERNAL_ERROR, "Internal discovery error"),
            )
        }
    }
}
