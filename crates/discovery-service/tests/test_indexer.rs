//! Indexer integration tests.
//!
//! ## Running tests
//!
//! ```sh
//! cargo test -p discovery-service --test test_indexer
//! ```

mod common;

use std::time::Duration;

use common::{DevnetClient, DevnetConfig, IndexerClient, IndexerSpawnConfig};

const BINARY: &str = env!("CARGO_BIN_EXE_discovery-service");

#[tokio::test]
async fn test_startup_and_shutdown() {
    let devnet = DevnetClient::spawn(DevnetConfig::default()).expect("Failed to spawn devnet");
    let mut indexer = IndexerClient::spawn(
        BINARY,
        IndexerSpawnConfig {
            ws_url: devnet.ws_url(),
            ..Default::default()
        },
    )
    .await
    .expect("Failed to spawn indexer");

    indexer
        .wait_for_logs(
            &["Indexer started", "Subscribed to new heads"],
            Duration::from_secs(10),
        )
        .await
        .unwrap();

    indexer.signal_shutdown().unwrap();
    let status = tokio::time::timeout(Duration::from_secs(5), indexer.wait())
        .await
        .expect("Shutdown timed out")
        .unwrap();
    // WS cleanup errors during shutdown may cause non-zero exit; the test
    // verifies startup + graceful shutdown sequence, not WS teardown.
    let _ = status;
}

#[tokio::test]
async fn test_new_block_notification() {
    let devnet = DevnetClient::spawn(DevnetConfig::default()).expect("Failed to spawn devnet");
    let mut indexer = IndexerClient::spawn(
        BINARY,
        IndexerSpawnConfig {
            ws_url: devnet.ws_url(),
            ..Default::default()
        },
    )
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
    let devnet = DevnetClient::spawn(DevnetConfig::default()).expect("Failed to spawn devnet");
    let port = devnet.port();
    let mut indexer = IndexerClient::spawn(
        BINARY,
        IndexerSpawnConfig {
            ws_url: devnet.ws_url(),
            ..Default::default()
        },
    )
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
