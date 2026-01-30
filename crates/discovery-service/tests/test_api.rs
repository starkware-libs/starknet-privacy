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
use discovery_service::incoming_sync::{IncomingSyncCursor, IncomingSyncRequest};
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
        cursor: Default::default(),
        max_reads: Some(1000),
    };

    let response = indexer.incoming_sync(&request).await.unwrap();

    // Verify response structure
    assert!(response.channels_done, "All channels should be discovered");
    let head = response.head.expect("head should be present on first sync");
    assert!(head.block_number > 0, "Should have a valid head");

    // Response cursor should have block_ref set for subsequent requests
    assert!(
        response.cursor.block_ref.is_some(),
        "cursor.block_ref should be set"
    );
    assert_eq!(
        response.cursor.block_ref.unwrap(),
        head.block_hash,
        "cursor.block_ref should match head.block_hash"
    );

    // NOTE: The test fixture may not have channels for Alice depending on the dump state.
    // If channels exist, verify their structure is correct.
    for (channel_key, channel) in &response.channels {
        assert!(*channel_key != Felt::ZERO, "Channel key should not be zero");
        assert!(
            channel.subchannels_done,
            "Subchannels should be fully discovered"
        );

        for (token, subchannel) in &channel.subchannels {
            assert!(*token != Felt::ZERO, "Token should not be zero");
            assert!(subchannel.notes_done, "Notes should be fully discovered");
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
        cursor: Default::default(),
        max_reads: Some(1),
    };

    let response1 = indexer.incoming_sync(&request1).await.unwrap();

    // Response cursor should have block_ref set
    assert!(response1.cursor.block_ref.is_some());

    // Second sync using the cursor (which includes block_ref)
    let request2 = IncomingSyncRequest {
        recipient_address: metadata.alice_address,
        decryption_key: metadata.alice_private_key,
        cursor: response1.cursor.clone(),
        max_reads: Some(1000),
    };

    let response2 = indexer.incoming_sync(&request2).await.unwrap();

    // Second response should NOT have head (block_ref was provided)
    assert!(
        response2.head.is_none(),
        "head should not be present when block_ref provided"
    );

    // Should eventually complete
    assert!(
        response2.channels_done,
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
        cursor: IncomingSyncCursor {
            last_known_block: Some(fake_block),
            ..Default::default()
        },
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
