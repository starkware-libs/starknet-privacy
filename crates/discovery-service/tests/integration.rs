//! Integration tests for discovery-service.
//!
//! These tests spawn a real starknet-devnet instance and the discovery-service binary,
//! then verify behavior by parsing logs.

mod devnet;
mod indexer;

use std::time::Duration;

use devnet::DevnetClient;
use indexer::IndexerClient;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Row, SqlitePool};
use starknet::core::types::Felt;
use tempfile::TempDir;

const BINARY: &str = env!("CARGO_BIN_EXE_discovery-service");

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
    let devnet = DevnetClient::spawn().await.expect("Failed to spawn devnet");
    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), &temp_db.path)
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
    let devnet = DevnetClient::spawn().await.expect("Failed to spawn devnet");
    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), &temp_db.path)
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
    let devnet = DevnetClient::spawn().await.expect("Failed to spawn devnet");
    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), &temp_db.path)
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
    let devnet = DevnetClient::spawn().await.expect("Failed to spawn devnet");
    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), &temp_db.path)
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
    let _devnet2 = DevnetClient::spawn()
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
    let devnet = DevnetClient::spawn().await.expect("Failed to spawn devnet");
    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), &temp_db.path)
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
