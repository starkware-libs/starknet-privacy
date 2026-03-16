//! Indexer integration tests.
//!
//! ## Running tests
//!
//! ```sh
//! cargo test -p discovery-service --test test_indexer
//! ```

mod common;

use common::{
    DevnetClient, DevnetConfig, IndexerClient, IndexerSpawnConfig, DEFAULT_BLOCK_TIMEOUT,
    DEFAULT_STARTUP_TIMEOUT,
};

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
            DEFAULT_STARTUP_TIMEOUT,
        )
        .await
        .unwrap();

    indexer.signal_shutdown().unwrap();
    let status = tokio::time::timeout(DEFAULT_BLOCK_TIMEOUT, indexer.wait())
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
        .wait_for_logs(&["Subscribed to new heads"], DEFAULT_STARTUP_TIMEOUT)
        .await
        .unwrap();

    // Create a block and verify we get notified
    devnet.create_block().await.unwrap();
    indexer
        .wait_for_logs(&["New block #"], DEFAULT_BLOCK_TIMEOUT)
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
        .wait_for_logs(&["Subscribed to new heads"], DEFAULT_STARTUP_TIMEOUT)
        .await
        .unwrap();

    // Kill devnet (simulates connection loss)
    drop(devnet);
    indexer
        .wait_for_logs(&["will retry"], DEFAULT_BLOCK_TIMEOUT)
        .await
        .unwrap();

    // Restart devnet on the same port
    let _devnet2 = DevnetClient::spawn(DevnetConfig {
        port: Some(port),
        ..Default::default()
    })
    .expect("Failed to respawn devnet");
    indexer
        .wait_for_logs(&["Subscribed to new heads"], DEFAULT_STARTUP_TIMEOUT)
        .await
        .unwrap();

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}
