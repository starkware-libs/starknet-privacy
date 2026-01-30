//! Incoming sync endpoint for discovering channels, subchannels, and notes.
//!
//! This module provides the `/v1/discovery/incoming/sync` endpoint that allows
//! clients to discover their incoming channels and associated data.

mod discovery;
mod types;
mod validation;

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use discovery_core::io_budget::IoBudget;
use discovery_core::storage::StorageBackend;
use tracing::warn;

use crate::api_server::{error_codes, ApiErrorResponse, AppState};
use crate::chain_state::ChainState;

pub use discovery::run_discovery;
pub use types::{
    ChannelCursor, ChannelResult, IncomingSyncCursor, IncomingSyncRequest, IncomingSyncResponse,
    NoteResult, SubchannelCursor, SubchannelResult, DEFAULT_MAX_READS, MAX_READS_CAP,
};
use validation::ValidatedRequest;

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
    // 1. Validate request
    let validated = ValidatedRequest::from_request(request, &state.backend).await?;

    // 2. Create snapshot at query block
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

    // 3. Create I/O budget
    let budget = IoBudget::new(validated.max_reads as usize);

    // 4. Run concurrent discovery
    let discovery_output = discovery::run_discovery(
        snapshot,
        validated.recipient_address,
        validated.decryption_key,
        validated.cursor,
        budget,
    )
    .await
    .map_err(discovery_error_to_response)?;

    // 5. Build response
    // Prepare cursor for client to use in subsequent requests:
    // - Set block_ref to head.block_hash if this was first sync (ensures consistency)
    // - Clear last_known_block (only needed on first request of a session)
    let mut response_cursor = discovery_output.cursor;
    if let Some(ref head) = validated.head {
        response_cursor.block_ref = Some(head.block_hash);
    }
    response_cursor.last_known_block = None;

    Ok(IncomingSyncResponse {
        head: validated.head,
        channels_done: discovery_output.channels_done,
        channels: discovery_output.channels,
        cursor: response_cursor,
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
    }
}
