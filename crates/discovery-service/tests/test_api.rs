//! API server tests: health endpoint, incoming sync.
//!
//! Run with: `cargo test -p discovery-service --test api_tests`
//!
//! Update snapshots with: `UPDATE_EXPECT=1 cargo test -p discovery-service --test api_tests`

mod common;

use std::time::Duration;

use common::{
    setup_devnet_with_dump, setup_indexer, DevnetClient, DevnetConfig, IndexerClient,
    IndexerSpawnConfig,
};
use discovery_service::api_server::HealthResponse;
use discovery_service::incoming_sync::IncomingSyncRequest;
use starknet_core::types::Felt;

#[tokio::test]
async fn test_health_endpoint_returns_ok() {
    let devnet = DevnetClient::spawn(DevnetConfig::default()).expect("Failed to spawn devnet");
    let indexer = setup_indexer(&devnet, None).await;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("http://{}/health", indexer.api_host()))
        .send()
        .await
        .expect("Failed to send request");

    assert_eq!(resp.status(), 200);

    let health: HealthResponse = resp.json().await.expect("Failed to parse response");
    assert_eq!(health.status, "OK");
    assert!(health.chain_head.is_some());
    assert!(health.chain_head.unwrap().timestamp > 0);

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}

#[tokio::test]
async fn test_incoming_sync_basic() {
    let (devnet, metadata) = setup_devnet_with_dump().await;
    let indexer = setup_indexer(&devnet, Some(&metadata)).await;

    let request = IncomingSyncRequest {
        recipient_address: metadata.alice_address,
        decryption_key: metadata.alice_private_key,
        last_known_block: None,
        block_ref: None,
        cursor: Default::default(),
        max_reads: Some(1000),
    };

    let response = indexer.incoming_sync(&request).await.unwrap();

    // block_ref is always present
    assert!(response.block_ref != Felt::ZERO, "block_ref should be set");

    // With a large budget, all discovery should complete: cursor.channels is empty
    assert!(
        response.cursor.channels.is_empty(),
        "All channels should be fully discovered (pruned from cursor)"
    );

    // Verify result structure
    for (channel_key, channel) in &response.channels {
        assert!(*channel_key != Felt::ZERO, "Channel key should not be zero");
        for token in channel.subchannels.keys() {
            assert!(*token != Felt::ZERO, "Token should not be zero");
        }
    }

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}

#[tokio::test]
async fn test_incoming_sync_pagination() {
    let (devnet, metadata) = setup_devnet_with_dump().await;
    let indexer = setup_indexer(&devnet, Some(&metadata)).await;

    // First sync with very small budget (1 read - should just get channel count)
    let request1 = IncomingSyncRequest {
        recipient_address: metadata.alice_address,
        decryption_key: metadata.alice_private_key,
        last_known_block: None,
        block_ref: None,
        cursor: Default::default(),
        max_reads: Some(1),
    };

    let response1 = indexer.incoming_sync(&request1).await.unwrap();

    // Second sync using block_ref and cursor from previous response
    let request2 = IncomingSyncRequest {
        recipient_address: metadata.alice_address,
        decryption_key: metadata.alice_private_key,
        last_known_block: None,
        block_ref: Some(response1.block_ref),
        cursor: response1.cursor.clone(),
        max_reads: Some(1000),
    };

    let response2 = indexer.incoming_sync(&request2).await.unwrap();

    // Should eventually complete: cursor.channels empty means all done
    assert!(
        response2.cursor.channels.is_empty(),
        "Should complete with larger budget"
    );

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}

#[tokio::test]
async fn test_incoming_sync_block_reorged() {
    let (devnet, metadata) = setup_devnet_with_dump().await;
    let indexer = setup_indexer(&devnet, Some(&metadata)).await;

    // Use a fake block hash that doesn't exist (simulates reorg)
    let fake_block = Felt::from_hex("0xdeadbeefdeadbeefdeadbeefdeadbeef").unwrap();

    let request = IncomingSyncRequest {
        recipient_address: metadata.alice_address,
        decryption_key: metadata.alice_private_key,
        last_known_block: Some(fake_block),
        block_ref: None,
        cursor: Default::default(),
        max_reads: Some(1000),
    };

    let (status, error) = indexer.incoming_sync_error(&request).await.unwrap();

    assert_eq!(status, 409);
    assert_eq!(error.error.code, "BLOCK_REORGED");

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}

#[tokio::test]
async fn test_incoming_sync_no_head() {
    let devnet = DevnetClient::spawn(DevnetConfig::default()).expect("Failed to spawn devnet");

    let mut indexer = IndexerClient::spawn(
        env!("CARGO_BIN_EXE_discovery-service"),
        IndexerSpawnConfig {
            ws_url: devnet.ws_url(),
            ..Default::default()
        },
    )
    .await
    .expect("Failed to spawn indexer");

    // Wait for API server only (don't create any blocks)
    indexer
        .wait_for_log("API server listening", Duration::from_secs(10))
        .await
        .unwrap();

    // Use any address/key - it doesn't matter since indexer has no head yet
    let request = IncomingSyncRequest {
        recipient_address: Felt::from_hex("0x1234").unwrap(),
        decryption_key: Felt::from_hex("0x5678").unwrap(),
        last_known_block: None,
        block_ref: None,
        cursor: Default::default(),
        max_reads: Some(1000),
    };

    let (status, error) = indexer.incoming_sync_error(&request).await.unwrap();

    // Should return 503 SERVICE_UNAVAILABLE since no head is indexed yet
    assert_eq!(status, 503);
    assert_eq!(error.error.code, "SERVICE_UNAVAILABLE");

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}
