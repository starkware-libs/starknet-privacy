//! API route handlers.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use discovery_core::io_budget::IoBudget;
use discovery_core::storage_backend::StorageBackend;
use starknet_core::types::BlockId;
use tracing::{debug, warn};

use discovery_core::privacy_pool::felt_hex;
use discovery_core::privacy_pool::types::SecretFelt;

use crate::api::types::{
    error_codes, ApiErrorResponse, HealthResponse, IncomingSyncRequest, IncomingSyncResponse,
    OutgoingSyncRequest, OutgoingSyncResponse, PreflightCheckRequest, PreflightCheckResponse,
};
use crate::api::validators::{validate_block_ref, validate_cursor, validate_recipients};
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

// TODO: support filtering by tokens (see sdk)
async fn incoming_sync_impl<B>(
    state: &AppState<B>,
    request: IncomingSyncRequest,
) -> Result<IncomingSyncResponse, (StatusCode, ApiErrorResponse)>
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: Clone + Send + Sync + 'static,
{
    validate_cursor(&request.cursor, &state.validation_limits)?;
    let block_ref =
        validate_block_ref(request.last_known_block, request.block_ref, &state.backend).await?;
    let viewing_key = SecretFelt::new(request.viewing_key);

    let snapshot = state
        .backend
        .snapshot(request.contract_address, Some(BlockId::Hash(block_ref)))
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

    let budget = IoBudget::new(state.validation_limits.server_budget)
        .with_batch_budget(state.validation_limits.batch_budget);

    debug!(
        recipient = %format!("{:#x}", request.recipient_address),
        block = %block_ref,
        "incoming_sync request"
    );

    let discovery_output = discovery_core::sync::incoming_state::sync_incoming_state(
        &snapshot,
        request.recipient_address,
        &viewing_key,
        request.cursor,
        &budget,
    )
    .await
    .map_err(crate::api::types::discovery_error_to_response)?;

    debug!(
        channels = discovery_output.channels.len(),
        subchannels = discovery_output.subchannels.len(),
        notes = discovery_output.notes.len(),
        cursor_complete = discovery_output.cursor.is_complete(),
        "incoming_sync response"
    );

    Ok(IncomingSyncResponse {
        block_ref,
        channels: discovery_output.channels,
        subchannels: discovery_output.subchannels,
        notes: discovery_output.notes,
        cursor: discovery_output.cursor,
    })
}

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

// TODO: support "total-only" mode (see sdk)
async fn outgoing_sync_impl<B>(
    state: &AppState<B>,
    request: OutgoingSyncRequest,
) -> Result<OutgoingSyncResponse, (StatusCode, ApiErrorResponse)>
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: Clone + Send + Sync + 'static,
{
    validate_cursor(&request.cursor, &state.validation_limits)?;
    if let Some(ref recipients) = request.recipients {
        validate_recipients(recipients, &state.validation_limits)?;
    }
    let block_ref =
        validate_block_ref(request.last_known_block, request.block_ref, &state.backend).await?;
    let viewing_key = SecretFelt::new(request.viewing_key);

    let snapshot = state
        .backend
        .snapshot(request.contract_address, Some(BlockId::Hash(block_ref)))
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

    let budget = IoBudget::new(state.validation_limits.server_budget)
        .with_batch_budget(state.validation_limits.batch_budget);

    debug!(
        sender = felt_hex(&request.sender_address),
        recipients = ?request.recipients.as_ref().map(|r| r.len()),
        block = %block_ref,
        "outgoing_sync request"
    );

    let discovery_output = discovery_core::sync::outgoing_state::sync_outgoing_state(
        &snapshot,
        request.sender_address,
        &viewing_key,
        request.cursor,
        &budget,
        request.recipients.as_ref(),
    )
    .await
    .map_err(crate::api::types::discovery_error_to_response)?;

    debug!(
        channels = discovery_output.channels.len(),
        subchannels = discovery_output.subchannels.len(),
        cursor_complete = discovery_output.cursor.is_complete(),
        "outgoing_sync response"
    );

    Ok(OutgoingSyncResponse {
        block_ref,
        channels: discovery_output.channels,
        subchannels: discovery_output.subchannels,
        cursor: discovery_output.cursor,
    })
}

/// Handler for POST /v1/sync/preflight_check.
pub async fn preflight_check_handler<B>(
    State(state): State<Arc<AppState<B>>>,
    Json(request): Json<PreflightCheckRequest>,
) -> impl IntoResponse
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: Clone + Send + Sync + 'static,
{
    match preflight_check_impl(&state, request).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err((status, error)) => (status, Json(error)).into_response(),
    }
}

async fn preflight_check_impl<B>(
    state: &AppState<B>,
    request: PreflightCheckRequest,
) -> Result<PreflightCheckResponse, (StatusCode, ApiErrorResponse)>
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: Clone + Send + Sync + 'static,
{
    let head = state.backend.get_head().await.ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            ApiErrorResponse::new(error_codes::SERVICE_UNAVAILABLE, "No block indexed yet"),
        )
    })?;

    let snapshot = state
        .backend
        .snapshot(
            request.contract_address,
            Some(BlockId::Hash(head.block_hash)),
        )
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

    debug!(
        sender = felt_hex(&request.sender_address),
        recipient = felt_hex(&request.recipient),
        token = felt_hex(&request.token),
        block = %head.block_hash,
        "preflight_check request"
    );

    let result = discovery_core::sync::preflight_check::preflight_check(
        &snapshot,
        request.sender_address,
        &viewing_key,
        request.recipient,
        request.token,
    )
    .await
    .map_err(crate::api::types::discovery_error_to_response)?;

    Ok(PreflightCheckResponse {
        block_ref: head.block_hash,
        sender_registered: result.sender_registered,
        channel_exists: result.channel_exists,
        subchannel_exists: result.subchannel_exists,
    })
}
