//! API server tests: health endpoint, incoming sync.
//!
//! Run with: `cargo test -p discovery-service --test test_api`

mod common;

use common::{
    setup_devnet_with_dump, setup_indexer, DevnetClient, DevnetConfig, IndexerClient,
    IndexerSpawnConfig, DEFAULT_STARTUP_TIMEOUT,
};
use discovery_service::api::{HealthResponse, IncomingSyncRequest};
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
        contract_address: metadata.contract_address,
        recipient_address: metadata.alice_address,
        viewing_key: metadata.alice_viewing_key,
        last_known_block: None,
        block_ref: None,
        cursor: Default::default(),
    };

    let response = indexer.incoming_sync(&request).await.unwrap();

    // block_ref is always present
    assert!(response.block_ref != Felt::ZERO, "block_ref should be set");

    // With a large budget, all discovery should complete
    assert!(
        response.cursor.is_complete(),
        "All discovery should be complete"
    );

    // Alice has at least 1 incoming channel (self-channel from deposit)
    assert!(
        !response.channels.is_empty(),
        "Alice should have at least 1 incoming channel"
    );

    // Verify result structure
    for channel in &response.channels {
        assert!(
            channel.channel_key != Felt::ZERO,
            "Channel key should not be zero"
        );
    }
    for subchannel in &response.subchannels {
        assert!(subchannel.token != Felt::ZERO, "Token should not be zero");
    }

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}

#[tokio::test]
async fn test_incoming_sync_pagination() {
    let (devnet, metadata) = setup_devnet_with_dump().await;
    let indexer = setup_indexer(&devnet, Some(&metadata)).await;

    // First sync with default budget
    let request1 = IncomingSyncRequest {
        contract_address: metadata.contract_address,
        recipient_address: metadata.alice_address,
        viewing_key: metadata.alice_viewing_key,
        last_known_block: None,
        block_ref: None,
        cursor: Default::default(),
    };

    let response1 = indexer.incoming_sync(&request1).await.unwrap();

    // Second sync using block_ref and cursor from previous response
    let request2 = IncomingSyncRequest {
        contract_address: metadata.contract_address,
        recipient_address: metadata.alice_address,
        viewing_key: metadata.alice_viewing_key,
        last_known_block: None,
        block_ref: Some(response1.block_ref),
        cursor: response1.cursor.clone(),
    };

    let response2 = indexer.incoming_sync(&request2).await.unwrap();

    // Should eventually complete
    assert!(
        response2.cursor.is_complete(),
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
        contract_address: metadata.contract_address,
        recipient_address: metadata.alice_address,
        viewing_key: metadata.alice_viewing_key,
        last_known_block: Some(fake_block),
        block_ref: None,
        cursor: Default::default(),
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
        .wait_for_log("API server listening", DEFAULT_STARTUP_TIMEOUT)
        .await
        .unwrap();

    // Use any address/key - it doesn't matter since indexer has no head yet
    let request = IncomingSyncRequest {
        contract_address: Felt::from_hex("0x123").unwrap(),
        recipient_address: Felt::from_hex("0x1234").unwrap(),
        viewing_key: Felt::from_hex("0x5678").unwrap(),
        last_known_block: None,
        block_ref: None,
        cursor: Default::default(),
    };

    let (status, error) = indexer.incoming_sync_error(&request).await.unwrap();

    // Should return 503 SERVICE_UNAVAILABLE since no head is indexed yet
    assert_eq!(status, 503);
    assert_eq!(error.error.code, "SERVICE_UNAVAILABLE");

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}
