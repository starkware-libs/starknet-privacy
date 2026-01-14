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

use std::time::Duration;

use common::{DevnetClient, DevnetConfig, IndexerClient};
use discovery_core::storage::{IViews, StorageBackend};
use discovery_service::rpc_backend::{RpcBackend, RpcConfig};
use expect_test::expect;
use serde::Deserialize;
use starknet_core::types::Felt;
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

#[tokio::test]
async fn test_startup_and_shutdown() {
    let devnet = DevnetClient::spawn(DevnetConfig::default())
        .await
        .expect("Failed to spawn devnet");
    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url())
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
    let devnet = DevnetClient::spawn(DevnetConfig::default())
        .await
        .expect("Failed to spawn devnet");
    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url())
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
async fn test_reconnection_on_devnet_restart() {
    let devnet = DevnetClient::spawn(DevnetConfig::default())
        .await
        .expect("Failed to spawn devnet");
    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url())
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
