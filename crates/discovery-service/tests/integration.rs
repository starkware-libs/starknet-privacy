//! Integration tests for discovery-service.
//!
//! ## Running tests
//!
//! ```sh
//! cargo test -p discovery-service --test integration -- --test-threads=1
//! ```
//!
//! ## Updating snapshots
//!
//! When expected values change, update snapshots with:
//! ```sh
//! UPDATE_EXPECT=1 cargo test -p discovery-service --test integration
//! ```

mod common;

use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use common::{DevnetClient, DevnetConfig, IndexerClient};
use discovery_core::storage::{IViews, StorageBackend};
use discovery_service::rpc_backend::{RpcBackend, RpcConfig};
use expect_test::expect;
use reqwest::StatusCode;
use serde::Deserialize;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Row, SqlitePool};
use starknet_core::types::Felt;
use tempfile::TempDir;
use url::Url;

const BINARY: &str = env!("CARGO_BIN_EXE_discovery-service");
const DUMP_GZ: &[u8] = include_bytes!("fixtures/devnet-dump.json.gz");
const METADATA: &str = include_str!("fixtures/devnet-dump.metadata.json");

/// Metadata with contract addresses from devnet dump.
#[derive(Deserialize)]
struct Metadata {
    contract_address: Felt,
    alice_address: Felt,
}

fn load_metadata() -> Metadata {
    serde_json::from_str(METADATA).expect("failed to parse metadata")
}

async fn spawn_devnet_with_dump() -> DevnetClient {
    let mut devnet = DevnetClient::spawn(DevnetConfig {
        seed: 42,
        accounts: 3,
    })
    .await
    .expect("failed to spawn devnet");
    devnet
        .load_dump_bytes(DUMP_GZ)
        .await
        .expect("failed to load dump");
    devnet
}

// === RPC Backend Tests ===

#[tokio::test]
async fn test_public_key_lookup() {
    let devnet = spawn_devnet_with_dump().await;
    let metadata = load_metadata();

    let backend = RpcBackend::new(RpcConfig::new(
        Url::parse(&devnet.rpc_url()).unwrap(),
        metadata.contract_address,
    ))
    .unwrap();

    let snapshot = backend.snapshot(None).await.unwrap();

    // Alice should have a registered public key
    let alice_pubkey = snapshot
        .get_public_key(metadata.alice_address)
        .await
        .unwrap();
    expect![[r#"
        0x07913e4dbbc06e873598f6e0bb0076449079fbdd951650c7f7a258d1c6b6a82d
    "#]]
    .assert_eq(&format!("{:#066x}\n", alice_pubkey));

    // Random address should have no public key (zero)
    let random_pubkey = snapshot
        .get_public_key(Felt::from_hex("0xdeadbeef").unwrap())
        .await
        .unwrap();
    assert_eq!(random_pubkey, Felt::ZERO);
}

// === Indexer Tests ===

/// Counter for generating unique API server ports across tests.
static API_PORT_COUNTER: AtomicU16 = AtomicU16::new(19000);

/// Generate a unique API host address for tests.
fn test_api_host() -> String {
    let port = API_PORT_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("127.0.0.1:{}", port)
}

struct TempDb {
    _dir: TempDir,
    path: String,
}

fn temp_db(test_name: &str) -> TempDb {
    let dir = TempDir::with_prefix(format!("discovery-test-{}", test_name)).unwrap();
    let path = dir.path().join("discovery.db");
    TempDb {
        _dir: dir,
        path: path.to_string_lossy().into_owned(),
    }
}

fn extract_hash_from_log(line: &str) -> Option<String> {
    let start = line.find("0x")?;
    Some(line[start..].trim().to_string())
}

#[tokio::test]
async fn test_startup_and_shutdown() {
    let temp_db = temp_db("startup_shutdown");
    let devnet = DevnetClient::spawn(DevnetConfig::default())
        .await
        .expect("Failed to spawn devnet");
    let mut indexer =
        IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), &temp_db.path, &test_api_host())
            .await
            .expect("Failed to spawn indexer");

    indexer
        .wait_for_log("Indexer started", Duration::from_secs(10))
        .await
        .unwrap();
    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(10))
        .await
        .unwrap();

    indexer.signal_shutdown().unwrap();
    let status = indexer.wait().await.unwrap();
    assert!(status.success());
}

#[tokio::test]
async fn test_new_block_notification() {
    let temp_db = temp_db("new_block");
    let devnet = DevnetClient::spawn(DevnetConfig::default())
        .await
        .expect("Failed to spawn devnet");
    let mut indexer =
        IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), &temp_db.path, &test_api_host())
            .await
            .expect("Failed to spawn indexer");

    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(10))
        .await
        .unwrap();

    // Create a block and verify we get notified
    devnet.create_block().await.unwrap();
    indexer
        .wait_for_log("New block #", Duration::from_secs(5))
        .await
        .unwrap();

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}

#[tokio::test]
async fn test_reorg_notification() {
    let temp_db = temp_db("reorg");
    let devnet = DevnetClient::spawn(DevnetConfig::default())
        .await
        .expect("Failed to spawn devnet");
    let mut indexer =
        IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), &temp_db.path, &test_api_host())
            .await
            .expect("Failed to spawn indexer");

    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(10))
        .await
        .unwrap();

    // Create some blocks
    let block1 = devnet.create_block().await.unwrap();
    indexer
        .wait_for_log("New block #", Duration::from_secs(5))
        .await
        .unwrap();

    let _block2 = devnet.create_block().await.unwrap();
    indexer
        .wait_for_log("New block #", Duration::from_secs(5))
        .await
        .unwrap();

    // Abort to block1 (simulates reorg)
    devnet.abort_blocks(&block1).await.unwrap();
    indexer
        .wait_for_log("Reorg detected", Duration::from_secs(5))
        .await
        .unwrap();

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}

#[tokio::test]
async fn test_reconnection_on_devnet_restart() {
    let temp_db = temp_db("reconnection");
    let devnet = DevnetClient::spawn(DevnetConfig::default())
        .await
        .expect("Failed to spawn devnet");
    let mut indexer =
        IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), &temp_db.path, &test_api_host())
            .await
            .expect("Failed to spawn indexer");

    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(10))
        .await
        .unwrap();

    // Kill devnet (simulates connection loss)
    drop(devnet);
    indexer
        .wait_for_log("will retry", Duration::from_secs(10))
        .await
        .unwrap();

    // Restart devnet
    let _devnet2 = DevnetClient::spawn(DevnetConfig::default())
        .await
        .expect("Failed to respawn devnet");
    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(30))
        .await
        .unwrap();

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}

#[tokio::test]
async fn test_blocks_persisted_and_head_matches_latest() {
    let temp_db = temp_db("blocks_persisted");
    let devnet = DevnetClient::spawn(DevnetConfig::default())
        .await
        .expect("Failed to spawn devnet");
    let mut indexer =
        IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), &temp_db.path, &test_api_host())
            .await
            .expect("Failed to spawn indexer");

    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(10))
        .await
        .unwrap();

    let mut observed_hashes = Vec::new();
    for _ in 0..3 {
        devnet.create_block().await.unwrap();
        let line = indexer
            .wait_for_log("New block #", Duration::from_secs(5))
            .await
            .unwrap();
        let hash = extract_hash_from_log(&line).expect("Failed to parse hash from log");
        observed_hashes.push(hash);
    }

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();

    let options = SqliteConnectOptions::new()
        .filename(&temp_db.path)
        .read_only(true);
    let pool = SqlitePool::connect_with(options).await.unwrap();

    let head_height: Option<String> =
        sqlx::query_scalar("SELECT value FROM meta WHERE key = 'head_height'")
            .fetch_optional(&pool)
            .await
            .unwrap();
    let head_hash: Option<String> =
        sqlx::query_scalar("SELECT value FROM meta WHERE key = 'head_hash'")
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(head_height.is_some());
    assert!(head_hash.is_some());

    let latest_row = sqlx::query("SELECT height, hash FROM blocks ORDER BY height DESC LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    let latest_height: i64 = latest_row.get("height");
    let latest_hash: String = latest_row.get("hash");
    let head_height_parsed: i64 = head_height.unwrap().parse().unwrap();
    let head_hash_value = head_hash.unwrap();
    assert_eq!(head_height_parsed, latest_height);
    assert_eq!(head_hash_value, latest_hash);

    let stored_rows = sqlx::query("SELECT hash FROM blocks")
        .fetch_all(&pool)
        .await
        .unwrap();
    let stored_hashes: std::collections::HashSet<String> = stored_rows
        .into_iter()
        .map(|row| row.get::<String, _>("hash"))
        .collect();
    for hash in observed_hashes {
        let normalized = format!("{:#066x}", Felt::from_hex(&hash).unwrap());
        assert!(stored_hashes.contains(&normalized));
    }
}

// === API Tests ===

#[derive(Deserialize)]
#[allow(dead_code)]
struct HealthResponse {
    status: String,
    chain_head: Option<ChainHead>,
    lag_secs: u64,
}

#[derive(Deserialize)]
struct ChainHead {
    block_number: u64,
    block_hash: String,
    timestamp: u64,
}

#[tokio::test]
async fn test_health_endpoint_returns_ok() {
    let temp_db = temp_db("health_endpoint");
    let api_host = test_api_host();
    let devnet = DevnetClient::spawn(DevnetConfig::default())
        .await
        .expect("Failed to spawn devnet");
    let mut indexer =
        IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), &temp_db.path, &api_host)
            .await
            .expect("Failed to spawn indexer");

    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(10))
        .await
        .unwrap();

    // Create a block so we have a chain head
    devnet.create_block().await.unwrap();
    indexer
        .wait_for_log("New block #", Duration::from_secs(5))
        .await
        .unwrap();

    // Call health endpoint
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("http://{}/health", api_host))
        .send()
        .await
        .expect("Failed to call health endpoint");

    assert_eq!(resp.status(), StatusCode::OK);

    let health: HealthResponse = resp.json().await.expect("Failed to parse health response");
    assert_eq!(health.status, "OK");
    assert!(health.chain_head.is_some());
    let chain_head = health.chain_head.unwrap();
    assert!(chain_head.block_number > 0);
    assert!(chain_head.block_hash.starts_with("0x"));
    assert!(chain_head.timestamp > 0);

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}
