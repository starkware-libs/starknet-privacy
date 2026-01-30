//! API server tests: health endpoint, incoming sync.
//!
//! Run with: `cargo test -p discovery-service --test api_tests`
//!
//! Update snapshots with: `UPDATE_EXPECT=1 cargo test -p discovery-service --test api_tests`

mod common;

use std::time::Duration;

use common::{
    find_free_port, setup_devnet_with_dump, DevnetClient, DevnetConfig, IndexerClient,
    IndexerSpawnConfig,
};
use discovery_service::api_server::{ApiErrorResponse, HealthResponse};
use discovery_service::incoming_sync::{
    IncomingSyncCursor, IncomingSyncRequest, IncomingSyncResponse,
};
use starknet_core::types::Felt;

const BINARY: &str = env!("CARGO_BIN_EXE_discovery-service");

#[tokio::test]
async fn test_health_endpoint_returns_ok() {
    let devnet = DevnetClient::spawn(DevnetConfig::default()).expect("Failed to spawn devnet");
    let api_port = find_free_port().expect("Failed to find free port");
    let api_host = format!("127.0.0.1:{}", api_port);

    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), Some(&api_host))
        .await
        .expect("Failed to spawn indexer");

    indexer
        .wait_for_log("API server listening", Duration::from_secs(10))
        .await
        .unwrap();
    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(10))
        .await
        .unwrap();

    devnet.create_block().await.unwrap();
    indexer
        .wait_for_log("New block #", Duration::from_secs(5))
        .await
        .unwrap();

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("http://{}/health", api_host))
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

    // Spawn indexer
    let api_port = find_free_port().expect("Failed to find free port");
    let api_host = format!("127.0.0.1:{}", api_port);

    let mut indexer = IndexerClient::spawn_with_config(
        BINARY,
        IndexerSpawnConfig {
            ws_url: &devnet.ws_url(),
            api_host: Some(&api_host),
            contract_address: Some(metadata.contract_address),
            rpc_url: Some(&devnet.rpc_url()),
        },
    )
    .await
    .expect("Failed to spawn indexer");

    indexer
        .wait_for_log("API server listening", Duration::from_secs(10))
        .await
        .unwrap();
    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(10))
        .await
        .unwrap();

    devnet.create_block().await.unwrap();
    indexer
        .wait_for_log("New block #", Duration::from_secs(5))
        .await
        .unwrap();

    // Test sync
    let client = reqwest::Client::new();
    let request = IncomingSyncRequest {
        recipient_address: metadata.alice_address,
        decryption_key: metadata.alice_private_key,
        cursor: Default::default(),
        max_reads: Some(1000),
    };

    let resp = client
        .post(format!("http://{}/v1/discovery/incoming/sync", api_host))
        .json(&request)
        .send()
        .await
        .expect("Failed to send request");

    let status = resp.status();
    let body = resp.text().await.expect("Failed to read response body");
    if status != 200 {
        panic!("Expected 200, got {}: {}", status, body);
    }

    let response: IncomingSyncResponse =
        serde_json::from_str(&body).expect("Failed to parse response");

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

    // Spawn indexer
    let api_port = find_free_port().expect("Failed to find free port");
    let api_host = format!("127.0.0.1:{}", api_port);

    let mut indexer = IndexerClient::spawn_with_config(
        BINARY,
        IndexerSpawnConfig {
            ws_url: &devnet.ws_url(),
            api_host: Some(&api_host),
            contract_address: Some(metadata.contract_address),
            rpc_url: Some(&devnet.rpc_url()),
        },
    )
    .await
    .expect("Failed to spawn indexer");

    indexer
        .wait_for_log("API server listening", Duration::from_secs(10))
        .await
        .unwrap();
    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(10))
        .await
        .unwrap();

    devnet.create_block().await.unwrap();
    indexer
        .wait_for_log("New block #", Duration::from_secs(5))
        .await
        .unwrap();

    let client = reqwest::Client::new();

    // First sync with very small budget (1 read - should just get channel count)
    let request1 = IncomingSyncRequest {
        recipient_address: metadata.alice_address,
        decryption_key: metadata.alice_private_key,
        cursor: Default::default(),
        max_reads: Some(1),
    };

    let resp1 = client
        .post(format!("http://{}/v1/discovery/incoming/sync", api_host))
        .json(&request1)
        .send()
        .await
        .expect("Failed to send request");

    assert_eq!(resp1.status(), 200);
    let response1: IncomingSyncResponse = resp1.json().await.expect("Failed to parse response");

    // Response cursor should have block_ref set
    assert!(response1.cursor.block_ref.is_some());

    // Second sync using the cursor (which includes block_ref)
    let request2 = IncomingSyncRequest {
        recipient_address: metadata.alice_address,
        decryption_key: metadata.alice_private_key,
        cursor: response1.cursor.clone(),
        max_reads: Some(1000),
    };

    let resp2 = client
        .post(format!("http://{}/v1/discovery/incoming/sync", api_host))
        .json(&request2)
        .send()
        .await
        .expect("Failed to send request");

    assert_eq!(resp2.status(), 200);
    let response2: IncomingSyncResponse = resp2.json().await.expect("Failed to parse response");

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

    // Spawn indexer
    let api_port = find_free_port().expect("Failed to find free port");
    let api_host = format!("127.0.0.1:{}", api_port);

    let mut indexer = IndexerClient::spawn_with_config(
        BINARY,
        IndexerSpawnConfig {
            ws_url: &devnet.ws_url(),
            api_host: Some(&api_host),
            contract_address: Some(metadata.contract_address),
            rpc_url: Some(&devnet.rpc_url()),
        },
    )
    .await
    .expect("Failed to spawn indexer");

    indexer
        .wait_for_log("API server listening", Duration::from_secs(10))
        .await
        .unwrap();
    indexer
        .wait_for_log("Subscribed to new heads", Duration::from_secs(10))
        .await
        .unwrap();

    devnet.create_block().await.unwrap();
    indexer
        .wait_for_log("New block #", Duration::from_secs(5))
        .await
        .unwrap();

    let client = reqwest::Client::new();

    // Use a fake block hash that doesn't exist (simulates reorg)
    let fake_block = Felt::from_hex("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap();

    let request = IncomingSyncRequest {
        recipient_address: metadata.alice_address,
        decryption_key: metadata.alice_private_key,
        cursor: IncomingSyncCursor {
            last_known_block: Some(fake_block),
            ..Default::default()
        },
        max_reads: Some(1000),
    };

    let resp = client
        .post(format!("http://{}/v1/discovery/incoming/sync", api_host))
        .json(&request)
        .send()
        .await
        .expect("Failed to send request");

    // Should return 409 BLOCK_REORGED
    assert_eq!(resp.status(), 409);

    let error: ApiErrorResponse = resp.json().await.expect("Failed to parse error response");
    assert_eq!(error.error.code, "BLOCK_REORGED");

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}

#[tokio::test]
async fn test_incoming_sync_no_head() {
    let devnet = DevnetClient::spawn(DevnetConfig::default()).expect("Failed to spawn devnet");
    let api_port = find_free_port().expect("Failed to find free port");
    let api_host = format!("127.0.0.1:{}", api_port);

    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), Some(&api_host))
        .await
        .expect("Failed to spawn indexer");

    // Wait for API server only (don't create any blocks)
    indexer
        .wait_for_log("API server listening", Duration::from_secs(10))
        .await
        .unwrap();

    let client = reqwest::Client::new();

    // Use any address/key - it doesn't matter since indexer has no head yet
    let request = IncomingSyncRequest {
        recipient_address: Felt::from_hex("0x1234").unwrap(),
        decryption_key: Felt::from_hex("0x5678").unwrap(),
        cursor: Default::default(),
        max_reads: Some(1000),
    };

    let resp = client
        .post(format!("http://{}/v1/discovery/incoming/sync", api_host))
        .json(&request)
        .send()
        .await
        .expect("Failed to send request");

    // Should return 503 SERVICE_UNAVAILABLE since no head is indexed yet
    assert_eq!(resp.status(), 503);

    let error: ApiErrorResponse = resp.json().await.expect("Failed to parse error response");
    assert_eq!(error.error.code, "SERVICE_UNAVAILABLE");

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}
