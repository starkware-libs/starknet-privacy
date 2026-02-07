//! Handler and supporting logic for POST /v1/sync/incoming_state.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use discovery_core::io_budget::IoBudget;
use discovery_core::privacy_pool::felt_hex;
use discovery_core::storage_backend::StorageBackend;
use tracing::{debug, warn};

use crate::api_server::{discovery_error_to_response, error_codes, ApiErrorResponse, AppState};
use crate::chain_state::ChainState;

use super::types::{IncomingSyncRequest, IncomingSyncResponse};
use super::validation::ValidatedRequest;

/// Handler for POST /v1/sync/incoming_state.
pub async fn incoming_sync_handler<B>(
    State(state): State<Arc<AppState<B>>>,
    Json(request): Json<IncomingSyncRequest>,
) -> impl IntoResponse
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: Clone + Send + Sync + 'static,
{
    match incoming_sync_impl(&state, request).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
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
    let validated =
        ValidatedRequest::from_request(request, &state.backend, &state.validation_limits).await?;

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

    let budget = IoBudget::new(state.validation_limits.server_budget);

    debug!(
        recipient = felt_hex(&validated.recipient_address),
        block = %validated.block_ref,
        "incoming_sync request"
    );

    let discovery_output = discovery_core::sync::incoming_state::sync_incoming_state(
        &snapshot,
        validated.recipient_address,
        &validated.decryption_key,
        validated.cursor,
        &budget,
    )
    .await
    .map_err(discovery_error_to_response)?;

    debug!(
        channels = discovery_output.channels.len(),
        subchannels = discovery_output.subchannels.len(),
        notes = discovery_output.notes.len(),
        cursor_complete = discovery_output.cursor.is_complete(),
        "incoming_sync response"
    );

    Ok(IncomingSyncResponse {
        block_ref: validated.block_ref,
        channels: discovery_output.channels,
        subchannels: discovery_output.subchannels,
        notes: discovery_output.notes,
        cursor: discovery_output.cursor,
    })
}
