//! Tests that `RpcBackend` bounds the number of JSON-RPC calls it keeps in
//! flight against the node, for both the single-call and the batch path.
//!
//! ## Running tests
//!
//! ```sh
//! cargo test -p discovery-service --test test_rpc_concurrency_limit
//! ```

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use discovery_core::storage_backend::{RawStorageAccess, StorageBackend};
use discovery_service::config::RpcConfig;
use discovery_service::rpc_backend::{RpcBackend, RpcBackendError};
use serde_json::{json, Value};
use starknet_core::types::{BlockId, Felt};
use tokio::net::TcpListener;
use tokio::sync::Barrier;
use tokio::task::JoinSet;

/// Held open long enough that every call released by the barrier overlaps
/// unless something bounds the fan-out.
const RESPONSE_DELAY: Duration = Duration::from_millis(300);

/// Kept well above the request limit so the connection pool never becomes the
/// thing that bounds concurrency.
const MAX_IDLE_PER_HOST: usize = 32;

const CONTRACT_ADDRESS: Felt = Felt::from_hex_unchecked("0x1234");

/// Snapshots pin a concrete block number so no extra round trip is spent
/// resolving a block tag.
const SNAPSHOT_BLOCK: BlockId = BlockId::Number(1);

/// Server-side view of how much work the mock node was asked to do at once.
#[derive(Default)]
struct RequestCounters {
    num_in_flight: AtomicUsize,
    peak_num_in_flight: AtomicUsize,
    n_http_requests: AtomicUsize,
}

/// Answers `starknet_getStorageAt` — single or batched — after `RESPONSE_DELAY`,
/// echoing each requested storage key back as that slot's value so callers can
/// verify every response reached the request it belongs to.
async fn handle_jsonrpc(
    State(counters): State<Arc<RequestCounters>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    counters.n_http_requests.fetch_add(1, Ordering::SeqCst);
    let num_in_flight = counters.num_in_flight.fetch_add(1, Ordering::SeqCst) + 1;
    counters
        .peak_num_in_flight
        .fetch_max(num_in_flight, Ordering::SeqCst);

    tokio::time::sleep(RESPONSE_DELAY).await;

    let response = match &body {
        Value::Array(calls) => Value::Array(calls.iter().map(reply_to_call).collect()),
        single_call => reply_to_call(single_call),
    };

    counters.num_in_flight.fetch_sub(1, Ordering::SeqCst);
    Json(response)
}

fn reply_to_call(call: &Value) -> Value {
    let id = call.get("id").cloned().unwrap_or(Value::Null);
    let storage_key = call
        .get("params")
        .and_then(|params| params.get("key"))
        .and_then(Value::as_str)
        .expect("mock node only serves starknet_getStorageAt");
    json!({ "id": id, "jsonrpc": "2.0", "result": storage_key })
}

/// Starts the mock node on an ephemeral port and returns its URL together with
/// the counters its handler updates.
async fn spawn_mock_node() -> (String, Arc<RequestCounters>) {
    let counters = Arc::new(RequestCounters::default());
    let router = Router::new()
        .route("/", post(handle_jsonrpc))
        .with_state(Arc::clone(&counters));

    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .expect("bind mock node");
    let rpc_url = format!(
        "http://{}",
        listener.local_addr().expect("mock node local address")
    );

    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve mock node");
    });

    (rpc_url, counters)
}

fn build_backend(
    rpc_url: String,
    max_concurrent_requests: usize,
    max_batch_size: usize,
) -> RpcBackend {
    RpcBackend::new(RpcConfig {
        url: rpc_url,
        max_concurrent_requests,
        max_idle_per_host: MAX_IDLE_PER_HOST,
        max_batch_size,
        ..Default::default()
    })
    .expect("RPC config should be accepted")
}

/// Slots are `1..=num_slots`; the mock returns each slot's own value, so a slot
/// doubles as its expected result.
fn slots(num_slots: usize) -> Vec<Felt> {
    (1..=num_slots as u64).map(Felt::from).collect()
}

#[tokio::test]
async fn test_single_call_burst_respects_request_limit() {
    const MAX_CONCURRENT_REQUESTS: usize = 2;
    const BURST_SIZE: usize = 8;

    let (rpc_url, counters) = spawn_mock_node().await;
    let backend = build_backend(rpc_url, MAX_CONCURRENT_REQUESTS, 100);
    let snapshot = backend
        .snapshot(CONTRACT_ADDRESS, Some(SNAPSHOT_BLOCK))
        .await
        .expect("snapshot");

    let barrier = Arc::new(Barrier::new(BURST_SIZE));
    let mut burst = JoinSet::new();
    for slot in slots(BURST_SIZE) {
        let snapshot = snapshot.clone();
        let barrier = Arc::clone(&barrier);
        burst.spawn(async move {
            barrier.wait().await;
            (slot, snapshot.read_slot(slot).await.expect("read_slot"))
        });
    }

    let mut num_completed = 0;
    while let Some(joined) = burst.join_next().await {
        let (slot, value) = joined.expect("burst task should not panic");
        assert_eq!(
            value, slot,
            "each read_slot must return its own slot's value"
        );
        num_completed += 1;
    }

    assert_eq!(num_completed, BURST_SIZE, "every call must complete");
    assert_eq!(
        counters.n_http_requests.load(Ordering::SeqCst),
        BURST_SIZE,
        "each read_slot is exactly one HTTP request"
    );
    // Equality, not `<=`: a burst this wide must saturate the cap, so a harness that
    // serialized for an unrelated reason would fail rather than pass vacuously.
    let peak_num_in_flight = counters.peak_num_in_flight.load(Ordering::SeqCst);
    assert_eq!(
        peak_num_in_flight, MAX_CONCURRENT_REQUESTS,
        "node saw {peak_num_in_flight} concurrent calls, limit is {MAX_CONCURRENT_REQUESTS}"
    );
}

#[tokio::test]
async fn test_batch_burst_respects_request_limit() {
    const MAX_CONCURRENT_REQUESTS: usize = 2;
    const MAX_BATCH_SIZE: usize = 2;
    const SLOTS_PER_CALL: usize = 4;
    const BURST_SIZE: usize = 6;

    let (rpc_url, counters) = spawn_mock_node().await;
    let backend = build_backend(rpc_url, MAX_CONCURRENT_REQUESTS, MAX_BATCH_SIZE);
    let snapshot = backend
        .snapshot(CONTRACT_ADDRESS, Some(SNAPSHOT_BLOCK))
        .await
        .expect("snapshot");

    let barrier = Arc::new(Barrier::new(BURST_SIZE));
    let mut burst = JoinSet::new();
    for _ in 0..BURST_SIZE {
        let snapshot = snapshot.clone();
        let barrier = Arc::clone(&barrier);
        burst.spawn(async move {
            barrier.wait().await;
            snapshot
                .read_slots(slots(SLOTS_PER_CALL))
                .await
                .expect("read_slots")
        });
    }

    let mut num_completed = 0;
    while let Some(joined) = burst.join_next().await {
        let values = joined.expect("burst task should not panic");
        assert_eq!(
            values,
            slots(SLOTS_PER_CALL),
            "batched values must come back in request order"
        );
        num_completed += 1;
    }

    assert_eq!(num_completed, BURST_SIZE, "every call must complete");
    assert_eq!(
        counters.n_http_requests.load(Ordering::SeqCst),
        BURST_SIZE * SLOTS_PER_CALL / MAX_BATCH_SIZE,
        "each read_slots must chunk into one HTTP batch per max_batch_size slots"
    );
    let peak_num_in_flight = counters.peak_num_in_flight.load(Ordering::SeqCst);
    assert_eq!(
        peak_num_in_flight, MAX_CONCURRENT_REQUESTS,
        "node saw {peak_num_in_flight} concurrent batches, limit is {MAX_CONCURRENT_REQUESTS}"
    );
}

/// A single permit shared by single-call and multi-chunk callers must still let
/// every caller finish: permits are taken per HTTP round trip, never held
/// across the chunk loop.
#[tokio::test]
async fn test_mixed_burst_completes_under_single_permit() {
    const MAX_CONCURRENT_REQUESTS: usize = 1;
    const MAX_BATCH_SIZE: usize = 2;
    const SLOTS_PER_BATCH_CALL: usize = 4;
    const NUM_SINGLE_CALLS: usize = 4;
    const NUM_BATCH_CALLS: usize = 3;

    let (rpc_url, counters) = spawn_mock_node().await;
    let backend = build_backend(rpc_url, MAX_CONCURRENT_REQUESTS, MAX_BATCH_SIZE);
    let snapshot = backend
        .snapshot(CONTRACT_ADDRESS, Some(SNAPSHOT_BLOCK))
        .await
        .expect("snapshot");

    let barrier = Arc::new(Barrier::new(NUM_SINGLE_CALLS + NUM_BATCH_CALLS));
    let mut burst = JoinSet::new();
    for slot in slots(NUM_SINGLE_CALLS) {
        let snapshot = snapshot.clone();
        let barrier = Arc::clone(&barrier);
        burst.spawn(async move {
            barrier.wait().await;
            let value = snapshot.read_slot(slot).await.expect("read_slot");
            (vec![slot], vec![value])
        });
    }
    for _ in 0..NUM_BATCH_CALLS {
        let snapshot = snapshot.clone();
        let barrier = Arc::clone(&barrier);
        burst.spawn(async move {
            barrier.wait().await;
            let requested_slots = slots(SLOTS_PER_BATCH_CALL);
            let values = snapshot
                .read_slots(requested_slots.clone())
                .await
                .expect("read_slots");
            (requested_slots, values)
        });
    }

    let mut num_values = 0;
    while let Some(joined) = burst.join_next().await {
        let (requested_slots, values) = joined.expect("burst task should not panic");
        assert_eq!(
            values, requested_slots,
            "each value must match the slot it was requested for"
        );
        num_values += values.len();
    }

    assert_eq!(
        num_values,
        NUM_SINGLE_CALLS + NUM_BATCH_CALLS * SLOTS_PER_BATCH_CALL,
        "no requested slot may be dropped"
    );
    assert_eq!(
        counters.peak_num_in_flight.load(Ordering::SeqCst),
        MAX_CONCURRENT_REQUESTS,
        "a single permit must serialize the node's view of the burst"
    );
}

#[test]
fn test_zero_request_limit_rejected() {
    let Err(error) = RpcBackend::new(RpcConfig {
        max_concurrent_requests: 0,
        ..Default::default()
    }) else {
        panic!("a zero request limit admits no calls and must be rejected");
    };

    assert!(
        matches!(error, RpcBackendError::InvalidMaxConcurrentRequests),
        "expected InvalidMaxConcurrentRequests, got {error:?}"
    );
}
