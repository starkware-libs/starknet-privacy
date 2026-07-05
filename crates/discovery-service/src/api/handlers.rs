//! API route handlers.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use discovery_core::events_backend::RawEventAccess;
use discovery_core::io_budget::IoBudget;
use discovery_core::storage_backend::StorageBackend;
use starknet_core::types::{BlockId, Felt};
use tracing::debug;

use discovery_core::privacy_pool::felt_hex;

use crate::api::types::{
    error_codes, ApiErrorResponse, HealthResponse, HistoryRequest, HistoryResponse,
    IncomingSyncRequest, IncomingSyncResponse, OutgoingSyncRequest, OutgoingSyncResponse,
    PreflightCheckRequest, PreflightCheckResponse, SyncRequestBase,
};
use crate::api::validators::{
    validate_block_ref, validate_cursor, validate_history_cursor, validate_recipients,
    validate_viewing_key,
};
use crate::api::AppState;
use crate::chain_state::ChainState;
use discovery_core::discovery::CursorLimits;

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
                ("UNHEALTHY", lag, StatusCode::SERVICE_UNAVAILABLE)
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

/// Validated and resolved shared context for sync handlers.
struct SyncContext<S> {
    block_ref: BlockId,
    snapshot: S,
    budget: IoBudget,
    cursor_limits: CursorLimits,
}

/// Validates the shared request fields and builds the context needed by
/// both incoming and outgoing sync handlers.
///
/// `user_address` is the address whose public key should match the viewing key
/// (recipient for incoming, sender for outgoing).
async fn prepare_sync_context<B>(
    base: &SyncRequestBase,
    user_address: Felt,
    state: &AppState<B>,
) -> Result<SyncContext<B::Snapshot>, (StatusCode, ApiErrorResponse)>
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: Clone + Send + Sync + 'static,
{
    validate_cursor(&base.cursor, &state.validation_limits)?;
    let block_ref =
        validate_block_ref(base.last_known_block, base.block_ref, &state.backend).await?;

    let snapshot = state
        .backend
        .snapshot(base.contract_address, Some(block_ref))
        .await
        .map_err(crate::api::types::storage_error_to_response)?;

    validate_viewing_key(
        &base.viewing_key,
        user_address,
        &snapshot,
        &state.public_key_cache,
    )
    .await?;

    let budget = IoBudget::new(state.validation_limits.server_budget);
    let cursor_limits = state.validation_limits.cursor_limits;

    Ok(SyncContext {
        block_ref,
        snapshot,
        budget,
        cursor_limits,
    })
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
    let context = prepare_sync_context(&request.base, request.recipient_address, state).await?;

    debug!(
        recipient = %format!("{:#x}", request.recipient_address),
        block = ?context.block_ref,
        "incoming_sync request"
    );

    let discovery_output = discovery_core::sync::incoming_state::sync_incoming_state(
        &context.snapshot,
        request.recipient_address,
        &request.base.viewing_key,
        request.base.cursor,
        context.cursor_limits,
        &context.budget,
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
        block_ref: context.block_ref,
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
    if let Some(ref recipients) = request.recipients {
        validate_recipients(recipients, &state.validation_limits)?;
    }
    let context = prepare_sync_context(&request.base, request.sender_address, state).await?;

    debug!(
        sender = felt_hex(&request.sender_address),
        recipients = ?request.recipients.as_ref().map(|r| r.len()),
        block = ?context.block_ref,
        "outgoing_sync request"
    );

    let discovery_output = discovery_core::sync::outgoing_state::sync_outgoing_state(
        &context.snapshot,
        request.sender_address,
        &request.base.viewing_key,
        request.base.cursor,
        context.cursor_limits,
        &context.budget,
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
        block_ref: context.block_ref,
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
    let block_ref = BlockId::Hash(head.block_hash);

    let snapshot = state
        .backend
        .snapshot(request.contract_address, Some(block_ref))
        .await
        .map_err(crate::api::types::storage_error_to_response)?;

    validate_viewing_key(
        &request.viewing_key,
        request.sender_address,
        &snapshot,
        &state.public_key_cache,
    )
    .await?;

    debug!(
        sender = felt_hex(&request.sender_address),
        recipient = felt_hex(&request.recipient),
        token = felt_hex(&request.token),
        block = ?block_ref,
        "preflight_check request"
    );

    let result = discovery_core::sync::preflight_check::preflight_check(
        &snapshot,
        request.sender_address,
        &request.viewing_key,
        request.recipient,
        request.token,
    )
    .await
    .map_err(crate::api::types::discovery_error_to_response)?;

    Ok(PreflightCheckResponse {
        block_ref,
        sender_registered: result.sender_registered,
        channel_exists: result.channel_exists,
        subchannel_exists: result.subchannel_exists,
    })
}

/// Handler for POST /v1/history.
pub async fn history_handler<B>(
    State(state): State<Arc<AppState<B>>>,
    Json(request): Json<HistoryRequest>,
) -> impl IntoResponse
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: RawEventAccess + Clone + Send + Sync + 'static,
{
    match history_impl(&state, request).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err((status, error)) => (status, Json(error)).into_response(),
    }
}

async fn history_impl<B>(
    state: &AppState<B>,
    request: HistoryRequest,
) -> Result<HistoryResponse, (StatusCode, ApiErrorResponse)>
where
    B: StorageBackend + ChainState + Clone + Send + Sync + 'static,
    B::Snapshot: RawEventAccess + Clone + Send + Sync + 'static,
{
    validate_history_cursor(
        &request.cursor,
        request.max_transactions,
        &state.validation_limits,
    )?;

    let block_ref =
        validate_block_ref(request.last_known_block, request.block_ref, &state.backend).await?;

    let snapshot = state
        .backend
        .snapshot(request.contract_address, Some(block_ref))
        .await
        .map_err(crate::api::types::storage_error_to_response)?;

    let mut cursor = request.cursor;

    debug!(
        user = %format!("{:#x}", request.user_address),
        block = ?block_ref,
        num_subchannels = cursor.subchannels.len(),
        begin_block_number = ?cursor.begin_block_number,
        "history request"
    );

    let budget = IoBudget::new(state.validation_limits.server_budget);
    let transactions = discovery_core::history::transactions::fetch_transactions(
        &snapshot,
        request.user_address,
        &mut cursor,
        request.max_transactions as usize,
        &budget,
    )
    .await
    .map_err(crate::api::types::discovery_error_to_response)?;

    debug!(
        num_transactions = transactions.len(),
        history_complete = cursor.history_complete,
        "history response"
    );

    Ok(HistoryResponse {
        block_ref,
        transactions,
        cursor,
    })
}
