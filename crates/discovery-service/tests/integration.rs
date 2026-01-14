//! Integration tests for discovery-service.
//!
//! These tests spawn a real starknet-devnet instance and the discovery-service binary,
//! then verify behavior by parsing logs.

mod devnet;
mod indexer;

use std::time::Duration;

use devnet::Devnet;
use indexer::Indexer;

const BINARY: &str = env!("CARGO_BIN_EXE_discovery-service");

#[tokio::test]
async fn test_startup_and_shutdown() {
    let devnet = Devnet::spawn().await.expect("Failed to spawn devnet");
    let mut indexer = Indexer::spawn_with_binary(BINARY, &devnet.ws_url())
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
    let devnet = Devnet::spawn().await.expect("Failed to spawn devnet");
    let mut indexer = Indexer::spawn_with_binary(BINARY, &devnet.ws_url())
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
    let devnet = Devnet::spawn().await.expect("Failed to spawn devnet");
    let mut indexer = Indexer::spawn_with_binary(BINARY, &devnet.ws_url())
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
    let devnet = Devnet::spawn().await.expect("Failed to spawn devnet");
    let mut indexer = Indexer::spawn_with_binary(BINARY, &devnet.ws_url())
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
    let _devnet2 = Devnet::spawn().await.expect("Failed to respawn devnet");
    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(30))
        .await
        .unwrap();

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}
