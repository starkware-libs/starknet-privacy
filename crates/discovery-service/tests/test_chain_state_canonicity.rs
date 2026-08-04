//! Tests that `RpcBackend` decides block canonicity — not mere existence — from
//! reorg notifications and, when those do not cover a hash, from what the node
//! currently carries at that hash's height.
//!
//! ## Running tests
//!
//! ```sh
//! cargo test -p discovery-service --test test_chain_state_canonicity
//! ```

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use discovery_service::chain_state::{ChainState, ChainStateError};
use discovery_service::config::RpcConfig;
use discovery_service::rpc_backend::RpcBackend;
use serde_json::{json, Value};
use starknet_core::types::{
    BlockStatus, BlockWithTxHashes, Felt, L1DataAvailabilityMode,
    MaybePreConfirmedBlockWithTxHashes, PreConfirmedBlockWithTxHashes, ResourcePrice,
};
use tokio::net::TcpListener;
use tokio::task::JoinSet;

/// Every test runs against a single request permit, so a canonicity check that
/// held a permit across its second round trip would hang instead of pass.
const MAX_CONCURRENT_REQUESTS: usize = 1;

const ORPHANED_BLOCK_NUMBER: u64 = 100;
const ORPHANED_HASH: Felt = Felt::from_hex_unchecked("0xa11ce");
const REPLACEMENT_HASH: Felt = Felt::from_hex_unchecked("0xb0b");
const UNKNOWN_HASH: Felt = Felt::from_hex_unchecked("0xdeadbeef");

/// JSON-RPC error code outside the Starknet error set, so the client surfaces it
/// as a transport-level failure rather than a `BlockNotFound`.
const INTERNAL_ERROR_CODE: i64 = -32603;

/// Named rather than a bare tuple so the two collections below cannot be read in
/// the wrong order.
#[derive(Clone, Copy)]
struct BlockAtHeight {
    block_number: u64,
    block_hash: Felt,
}

/// A node that serves `starknet_getBlockWithTxHashes`.
///
/// `canonical_blocks` is what each height resolves to now; `addressable_blocks` is
/// every block still reachable by hash, orphans included. The gap between the two
/// is what a canonicity check has to see through.
#[derive(Default)]
struct MockNode {
    canonical_blocks: Vec<BlockAtHeight>,
    addressable_blocks: Vec<BlockAtHeight>,
    /// Heights the node reports as a pre-confirmed block, which carries no hash.
    pre_confirmed_block_numbers: Vec<u64>,
    /// Heights the node reports as `ACCEPTED_ON_L1`, i.e. final.
    l1_accepted_block_numbers: Vec<u64>,
    /// When set, every call fails with this JSON-RPC error code.
    error_code: Option<i64>,
    n_block_requests: AtomicUsize,
}

impl MockNode {
    fn block_number_of(&self, block_hash: Felt) -> Option<u64> {
        self.addressable_blocks
            .iter()
            .find(|block| block.block_hash == block_hash)
            .map(|block| block.block_number)
    }

    fn canonical_hash_at(&self, block_number: u64) -> Option<Felt> {
        self.canonical_blocks
            .iter()
            .find(|block| block.block_number == block_number)
            .map(|block| block.block_hash)
    }

    fn n_block_requests(&self) -> usize {
        self.n_block_requests.load(Ordering::SeqCst)
    }
}

async fn handle_jsonrpc(State(node): State<Arc<MockNode>>, Json(body): Json<Value>) -> Json<Value> {
    node.n_block_requests.fetch_add(1, Ordering::SeqCst);

    let request_id = body.get("id").cloned().unwrap_or(Value::Null);
    assert_eq!(
        body.get("method").and_then(Value::as_str),
        Some("starknet_getBlockWithTxHashes"),
        "a canonicity check must not call anything else"
    );

    if let Some(error_code) = node.error_code {
        return Json(json!({
            "id": request_id,
            "jsonrpc": "2.0",
            "error": { "code": error_code, "message": "mock node failure" },
        }));
    }

    let block_id = body
        .get("params")
        .and_then(|params| params.get("block_id"))
        .expect("block_id parameter");
    let requested_hash = block_id
        .get("block_hash")
        .and_then(Value::as_str)
        .map(|hash_text| Felt::from_hex(hash_text).expect("hex block hash"));

    let block_number = match requested_hash {
        Some(block_hash) => node.block_number_of(block_hash),
        None => {
            let requested_number = block_id
                .get("block_number")
                .and_then(Value::as_u64)
                .expect("block_id names either a hash or a number");
            (node.canonical_hash_at(requested_number).is_some()
                || node.pre_confirmed_block_numbers.contains(&requested_number))
            .then_some(requested_number)
        }
    };

    let block = match block_number {
        None => {
            return Json(json!({
                "id": request_id,
                "jsonrpc": "2.0",
                "error": { "code": 24, "message": "Block not found" },
            }))
        }
        Some(block_number) if node.pre_confirmed_block_numbers.contains(&block_number) => {
            pre_confirmed_block(block_number)
        }
        Some(block_number) => confirmed_block(
            block_number,
            requested_hash
                .or_else(|| node.canonical_hash_at(block_number))
                .expect("a confirmed block has a hash"),
            node.l1_accepted_block_numbers.contains(&block_number),
        ),
    };

    Json(json!({
        "id": request_id,
        "jsonrpc": "2.0",
        "result": serde_json::to_value(block).expect("serialize block"),
    }))
}

fn resource_price() -> ResourcePrice {
    ResourcePrice {
        price_in_fri: Felt::ONE,
        price_in_wei: Felt::ONE,
    }
}

fn confirmed_block(
    block_number: u64,
    block_hash: Felt,
    is_l1_accepted: bool,
) -> MaybePreConfirmedBlockWithTxHashes {
    MaybePreConfirmedBlockWithTxHashes::Block(BlockWithTxHashes {
        status: if is_l1_accepted {
            BlockStatus::AcceptedOnL1
        } else {
            BlockStatus::AcceptedOnL2
        },
        block_hash,
        parent_hash: Felt::ZERO,
        block_number,
        new_root: Felt::ZERO,
        timestamp: 1_700_000_000 + block_number,
        sequencer_address: Felt::ZERO,
        l1_gas_price: resource_price(),
        l2_gas_price: resource_price(),
        l1_data_gas_price: resource_price(),
        l1_da_mode: L1DataAvailabilityMode::Blob,
        starknet_version: "0.14.0".to_string(),
        event_commitment: Felt::ZERO,
        transaction_commitment: Felt::ZERO,
        receipt_commitment: Felt::ZERO,
        state_diff_commitment: Felt::ZERO,
        event_count: 0,
        transaction_count: 0,
        state_diff_length: 0,
        transactions: vec![],
    })
}

fn pre_confirmed_block(block_number: u64) -> MaybePreConfirmedBlockWithTxHashes {
    MaybePreConfirmedBlockWithTxHashes::PreConfirmedBlock(PreConfirmedBlockWithTxHashes {
        transactions: vec![],
        block_number,
        timestamp: 1_700_000_000 + block_number,
        sequencer_address: Felt::ZERO,
        l1_gas_price: resource_price(),
        l2_gas_price: resource_price(),
        l1_data_gas_price: resource_price(),
        l1_da_mode: L1DataAvailabilityMode::Blob,
        starknet_version: "0.14.0".to_string(),
    })
}

/// Serves `node` on an ephemeral port and returns a backend pointed at it.
async fn spawn_backend(node: MockNode) -> (RpcBackend, Arc<MockNode>) {
    let node = Arc::new(node);
    let router = Router::new()
        .route("/", post(handle_jsonrpc))
        .with_state(Arc::clone(&node));

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

    let backend = RpcBackend::new(RpcConfig {
        url: rpc_url,
        max_concurrent_requests: MAX_CONCURRENT_REQUESTS,
        ..Default::default()
    })
    .expect("RPC config should be accepted");
    (backend, node)
}

/// The node still serves the orphaned block by hash, but its height now resolves
/// to a different block. Existence alone would call this canonical.
#[tokio::test]
async fn test_orphaned_hash_at_reused_height_is_not_canonical() {
    let (backend, node) = spawn_backend(MockNode {
        canonical_blocks: vec![BlockAtHeight {
            block_number: ORPHANED_BLOCK_NUMBER,
            block_hash: REPLACEMENT_HASH,
        }],
        addressable_blocks: vec![
            BlockAtHeight {
                block_number: ORPHANED_BLOCK_NUMBER,
                block_hash: ORPHANED_HASH,
            },
            BlockAtHeight {
                block_number: ORPHANED_BLOCK_NUMBER,
                block_hash: REPLACEMENT_HASH,
            },
        ],
        ..Default::default()
    })
    .await;

    assert!(
        !backend.is_canonical(ORPHANED_HASH).await.unwrap(),
        "a hash the node still serves is not canonical once its height carries another block"
    );
    assert_eq!(
        node.n_block_requests(),
        2,
        "deciding this takes a hash -> height and a height -> hash call"
    );
}

#[tokio::test]
async fn test_canonical_hash_is_canonical() {
    let (backend, node) = spawn_backend(MockNode {
        canonical_blocks: vec![BlockAtHeight {
            block_number: ORPHANED_BLOCK_NUMBER,
            block_hash: REPLACEMENT_HASH,
        }],
        addressable_blocks: vec![BlockAtHeight {
            block_number: ORPHANED_BLOCK_NUMBER,
            block_hash: REPLACEMENT_HASH,
        }],
        ..Default::default()
    })
    .await;

    assert!(backend.is_canonical(REPLACEMENT_HASH).await.unwrap());
    assert_eq!(node.n_block_requests(), 2);
}

/// An L1-accepted block is final, so its identity is settled by the first call and
/// the height lookup is skipped.
#[tokio::test]
async fn test_l1_accepted_hash_is_canonical_in_one_call() {
    let (backend, node) = spawn_backend(MockNode {
        canonical_blocks: vec![BlockAtHeight {
            block_number: ORPHANED_BLOCK_NUMBER,
            block_hash: REPLACEMENT_HASH,
        }],
        addressable_blocks: vec![BlockAtHeight {
            block_number: ORPHANED_BLOCK_NUMBER,
            block_hash: REPLACEMENT_HASH,
        }],
        l1_accepted_block_numbers: vec![ORPHANED_BLOCK_NUMBER],
        ..Default::default()
    })
    .await;

    assert!(backend.is_canonical(REPLACEMENT_HASH).await.unwrap());
    assert_eq!(
        node.n_block_requests(),
        1,
        "finality settles the answer, so the height lookup must be skipped"
    );
}

/// A hash the node still serves as L1-accepted at a height that now carries another
/// block would be a node contradicting itself; the short-circuit trusts finality.
#[tokio::test]
async fn test_unknown_hash_is_not_canonical() {
    let (backend, node) = spawn_backend(MockNode::default()).await;

    assert!(!backend.is_canonical(UNKNOWN_HASH).await.unwrap());
    assert_eq!(
        node.n_block_requests(),
        1,
        "a hash the node does not know needs no second call"
    );
}

#[tokio::test]
async fn test_rpc_failure_is_reported_as_error() {
    let (backend, _node) = spawn_backend(MockNode {
        error_code: Some(INTERNAL_ERROR_CODE),
        ..Default::default()
    })
    .await;

    let result = backend.is_canonical(REPLACEMENT_HASH).await;
    assert!(
        matches!(result, Err(ChainStateError::RpcError(_))),
        "an unreachable node must leave canonicity unknown, not answer it"
    );
}

/// A height the node serves as pre-confirmed carries no hash, so nothing can
/// match it — and resolving it must not panic on the missing field.
#[tokio::test]
async fn test_pre_confirmed_height_is_not_canonical() {
    let (backend, node) = spawn_backend(MockNode {
        addressable_blocks: vec![BlockAtHeight {
            block_number: ORPHANED_BLOCK_NUMBER,
            block_hash: ORPHANED_HASH,
        }],
        pre_confirmed_block_numbers: vec![ORPHANED_BLOCK_NUMBER],
        ..Default::default()
    })
    .await;

    assert!(!backend.is_canonical(ORPHANED_HASH).await.unwrap());
    assert_eq!(
        node.n_block_requests(),
        1,
        "a pre-confirmed answer to the hash lookup already settles the question"
    );
}

/// Both round trips take a request permit in turn, so a burst of canonicity
/// checks completes even when the node admits one call at a time.
#[tokio::test]
async fn test_canonicity_burst_completes_under_single_permit() {
    const BURST_SIZE: usize = 8;

    let (backend, node) = spawn_backend(MockNode {
        canonical_blocks: vec![BlockAtHeight {
            block_number: ORPHANED_BLOCK_NUMBER,
            block_hash: REPLACEMENT_HASH,
        }],
        addressable_blocks: vec![
            BlockAtHeight {
                block_number: ORPHANED_BLOCK_NUMBER,
                block_hash: ORPHANED_HASH,
            },
            BlockAtHeight {
                block_number: ORPHANED_BLOCK_NUMBER,
                block_hash: REPLACEMENT_HASH,
            },
        ],
        ..Default::default()
    })
    .await;

    let mut burst = JoinSet::new();
    for _ in 0..BURST_SIZE {
        let backend = backend.clone();
        burst.spawn(async move {
            (
                backend.is_canonical(REPLACEMENT_HASH).await.unwrap(),
                backend.is_canonical(ORPHANED_HASH).await.unwrap(),
            )
        });
    }

    let mut num_completed = 0;
    while let Some(joined) = burst.join_next().await {
        assert_eq!(
            joined.expect("burst task should not panic"),
            (true, false),
            "every check must reach the same verdicts"
        );
        num_completed += 1;
    }

    assert_eq!(num_completed, BURST_SIZE, "every check must complete");
    assert_eq!(node.n_block_requests(), BURST_SIZE * 4);
}
