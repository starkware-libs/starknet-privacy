//! Handler and supporting logic for POST /v1/sync/outgoing_state.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use discovery_core::io_budget::IoBudget;
use discovery_core::privacy_pool::felt_hex;
use discovery_core::privacy_pool::types::SecretFelt;
use discovery_core::storage_backend::StorageBackend;
use tracing::{debug, warn};

use crate::api_server::{discovery_error_to_response, error_codes, ApiErrorResponse, AppState};
use crate::chain_state::ChainState;
use crate::incoming_sync::validation::validate_sync_params;

use super::types::{OutgoingSyncRequest, OutgoingSyncResponse};

/// Handler for POST /v1/sync/outgoing_state.
pub async fn outgoing_sync_handler<B>(
    State(state): State<Arc<AppState<B>>>,
    Json(request): Json<OutgoingSyncRequest>,
) -> impl IntoResponse
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: Clone + Send + Sync + 'static,
{
    match outgoing_sync_impl(&state, request).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err((status, error)) => (status, Json(error)).into_response(),
    }
}

async fn outgoing_sync_impl<B>(
    state: &AppState<B>,
    request: OutgoingSyncRequest,
) -> Result<OutgoingSyncResponse, (StatusCode, ApiErrorResponse)>
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: Clone + Send + Sync + 'static,
{
    if let Some(ref recipients) = request.recipients {
        crate::incoming_sync::validation::validate_recipients(
            recipients,
            &state.validation_limits,
        )?;
    }

    let params = validate_sync_params(
        request.last_known_block,
        request.block_ref,
        request.cursor,
        &state.backend,
        &state.validation_limits,
    )
    .await?;

    let snapshot = state
        .backend
        .snapshot(Some(params.query_block))
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

    let decryption_key = SecretFelt::new(request.decryption_key);
    let budget = IoBudget::new(state.validation_limits.server_budget);

    debug!(
        sender = felt_hex(&request.sender_address),
        recipients = ?request.recipients.as_ref().map(|r| r.len()),
        block = %params.block_ref,
        "outgoing_sync request"
    );

    let discovery_output = discovery_core::sync::outgoing_state::sync_outgoing_state(
        &snapshot,
        request.sender_address,
        &decryption_key,
        params.cursor,
        &budget,
        request.recipients.as_ref(),
    )
    .await
    .map_err(discovery_error_to_response)?;

    debug!(
        channels = discovery_output.channels.len(),
        subchannels = discovery_output.subchannels.len(),
        cursor_complete = discovery_output.cursor.is_complete(),
        "outgoing_sync response"
    );

    Ok(OutgoingSyncResponse {
        block_ref: params.block_ref,
        channels: discovery_output.channels,
        subchannels: discovery_output.subchannels,
        cursor: discovery_output.cursor,
    })
}
