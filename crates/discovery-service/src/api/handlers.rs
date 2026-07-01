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
use tracing::{debug, warn};

use discovery_core::privacy_pool::felt_hex;

use crate::api::types::{
    error_codes, ApiErrorResponse, HealthResponse, HistoryRequest, HistoryResponse,
    IncomingSyncRequest, IncomingSyncResponse, OutgoingSyncRequest, OutgoingSyncResponse,
    PreflightCheckRequest, PreflightCheckResponse, SubAccountEntry, SubAccountsRequest,
    SubAccountsResponse, SyncRequestBase,
};
use crate::api::validators::{
    validate_block_ref, validate_cursor, validate_history_cursor, validate_recipients,
    validate_viewing_key,
};
use crate::api::AppState;
use crate::chain_state::ChainState;
use crate::rpc_backend::{ContractView, ContractViewError};
use discovery_core::discovery::CursorLimits;
use starknet_core::utils::get_selector_from_name;

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

/// Handler for POST /v1/sub_accounts.
/// Maximum nonce span a single `get_sub_accounts` call may scan. Mirrors the anonymizer's on-chain
/// `MAX_SCAN_RANGE` (packages/sub_account_anonymizer): the contract reverts above it, so the request
/// is rejected here as a client error (`400`) rather than allowed to fail on-chain as a `502`.
const MAX_SUB_ACCOUNT_SCAN_RANGE: u64 = 1024;

pub async fn sub_accounts_handler<B>(
    State(state): State<Arc<AppState<B>>>,
    Json(request): Json<SubAccountsRequest>,
) -> impl IntoResponse
where
    B: ContractView + ChainState + Clone + Send + Sync + 'static,
{
    match sub_accounts_impl(&state, request).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err((status, error)) => (status, Json(error)).into_response(),
    }
}

async fn sub_accounts_impl<B>(
    state: &AppState<B>,
    request: SubAccountsRequest,
) -> Result<SubAccountsResponse, (StatusCode, ApiErrorResponse)>
where
    B: ContractView + ChainState + Clone + Send + Sync + 'static,
{
    // Reject an over-large scan range as a client error before touching the chain. The anonymizer
    // reverts above `MAX_SCAN_RANGE`; without this guard that revert surfaces as a misleading
    // `502 RPC_UNAVAILABLE` (a `ContractViewError::Request`) rather than the `400` it is.
    if request.end_nonce.saturating_sub(request.start_nonce) > MAX_SUB_ACCOUNT_SCAN_RANGE {
        return Err((
            StatusCode::BAD_REQUEST,
            ApiErrorResponse::new(
                error_codes::INVALID_REQUEST,
                format!(
                    "nonce range {}..{} exceeds MAX_SCAN_RANGE ({})",
                    request.start_nonce, request.end_nonce, MAX_SUB_ACCOUNT_SCAN_RANGE
                ),
            ),
        ));
    }

    let block_ref =
        validate_block_ref(request.last_known_block, request.block_ref, &state.backend).await?;

    debug!(
        anonymizer = %format!("{:#x}", request.contract_address),
        start_nonce = request.start_nonce,
        end_nonce = request.end_nonce,
        block = ?block_ref,
        "sub_accounts request"
    );

    let resolved = state
        .backend
        .call_view(
            request.contract_address,
            selector("get_sub_accounts"),
            vec![
                request.partial_commitment,
                Felt::from(request.start_nonce),
                Felt::from(request.end_nonce),
            ],
            block_ref,
        )
        .await
        .map_err(contract_view_error_to_response)?;
    let sub_accounts = decode_sub_accounts(&resolved)?;

    debug!(resolved = sub_accounts.len(), "sub_accounts response");

    Ok(SubAccountsResponse {
        block_ref,
        sub_accounts,
    })
}

/// Selector for a statically-known entrypoint name (the name is a compile-time invariant).
fn selector(name: &str) -> Felt {
    get_selector_from_name(name).expect("valid entrypoint name")
}

/// Decodes `get_sub_accounts`'s `Span<SubAccountInfo>` return, serialized as
/// `[len, nonce_0, address_0, is_deployed_0, nonce_1, ...]` (3 felts per entry).
fn decode_sub_accounts(
    felts: &[Felt],
) -> Result<Vec<SubAccountEntry>, (StatusCode, ApiErrorResponse)> {
    let len = felt_to_u64(
        *felts
            .first()
            .ok_or_else(|| internal_error("get_sub_accounts returned no length"))?,
    ) as usize;
    let mut sub_accounts = Vec::with_capacity(len.min(felts.len() / 3));
    for index in 0..len {
        let base = 1 + index * 3;
        let entry = felts
            .get(base..base + 3)
            .ok_or_else(|| internal_error("get_sub_accounts result truncated"))?;
        sub_accounts.push(SubAccountEntry {
            nonce: felt_to_u64(entry[0]),
            address: entry[1],
            is_deployed: entry[2] != Felt::ZERO,
        });
    }
    Ok(sub_accounts)
}

/// Reads the low 8 bytes of a felt as a `u64` (nonces and span lengths fit in `u64`).
fn felt_to_u64(felt: Felt) -> u64 {
    let bytes = felt.to_bytes_be();
    u64::from_be_bytes(bytes[24..32].try_into().expect("8-byte slice"))
}

fn internal_error(message: &str) -> (StatusCode, ApiErrorResponse) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        ApiErrorResponse::new(error_codes::INTERNAL_ERROR, message),
    )
}

fn contract_view_error_to_response(error: ContractViewError) -> (StatusCode, ApiErrorResponse) {
    match error {
        ContractViewError::ContractNotFound => (
            StatusCode::NOT_FOUND,
            ApiErrorResponse::new(error_codes::CONTRACT_NOT_FOUND, error.to_string()),
        ),
        ContractViewError::Request(_) => {
            // Don't leak raw RPC/transport internals to the caller; log for observability instead.
            warn!("get_sub_accounts RPC call failed: {}", error);
            (
                StatusCode::BAD_GATEWAY,
                ApiErrorResponse::new(error_codes::RPC_UNAVAILABLE, "Upstream RPC is unavailable"),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_sub_accounts, felt_to_u64};
    use starknet_core::types::Felt;

    #[test]
    fn felt_to_u64_reads_low_bytes() {
        assert_eq!(felt_to_u64(Felt::from(0u64)), 0);
        assert_eq!(felt_to_u64(Felt::from(42u64)), 42);
        assert_eq!(felt_to_u64(Felt::from(u64::MAX)), u64::MAX);
    }

    #[test]
    fn decode_empty_span() {
        let decoded = decode_sub_accounts(&[Felt::ZERO]).unwrap();
        assert!(decoded.is_empty());
    }

    #[test]
    fn decode_span_of_entries() {
        // Span<SubAccountInfo> serialized as [len, (nonce, address, is_deployed) * len].
        let felts = [
            Felt::from(2u64),
            Felt::from(0u64),
            Felt::from(0xaaau64),
            Felt::ONE,
            Felt::from(1u64),
            Felt::from(0xbbbu64),
            Felt::ZERO,
        ];
        let decoded = decode_sub_accounts(&felts).unwrap();
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].nonce, 0);
        assert_eq!(decoded[0].address, Felt::from(0xaaau64));
        assert!(decoded[0].is_deployed);
        assert_eq!(decoded[1].nonce, 1);
        assert_eq!(decoded[1].address, Felt::from(0xbbbu64));
        assert!(!decoded[1].is_deployed);
    }

    #[test]
    fn decode_truncated_span_errors() {
        // len says 1 entry but the 3-felt tuple is missing.
        let result = decode_sub_accounts(&[Felt::from(1u64)]);
        assert!(result.is_err());
    }
}
