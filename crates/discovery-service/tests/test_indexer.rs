//! Indexer lifecycle tests: startup, shutdown, reconnection.
//!
//! Run with: `cargo test -p discovery-service --test indexer_tests`

mod common;

use std::time::Duration;

use common::{DevnetClient, DevnetConfig, IndexerClient};

const BINARY: &str = env!("CARGO_BIN_EXE_discovery-service");

#[tokio::test]
async fn test_startup_and_shutdown() {
    let devnet = DevnetClient::spawn(DevnetConfig::default()).expect("Failed to spawn devnet");
    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), None)
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
    let devnet = DevnetClient::spawn(DevnetConfig::default()).expect("Failed to spawn devnet");
    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), None)
        .await
        .expect("Failed to spawn indexer");

    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(10))
        .await
        .unwrap();

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
    let devnet = DevnetClient::spawn(DevnetConfig::default()).expect("Failed to spawn devnet");
    let port = devnet.port();
    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), None)
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

    // Restart devnet on the same port
    let _devnet2 = DevnetClient::spawn(DevnetConfig {
        port: Some(port),
        ..Default::default()
    })
    .expect("Failed to respawn devnet");
    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(30))
        .await
        .unwrap();

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}
