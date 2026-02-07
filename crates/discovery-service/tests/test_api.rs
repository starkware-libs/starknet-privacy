//! API server tests: health endpoint, incoming sync, outgoing sync, preflight.
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
use discovery_service::outgoing_sync::OutgoingSyncRequest;
use discovery_service::preflight::PreflightRequest;
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
        decryption_key: metadata.alice_decryption_key,
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
    for ch in &response.channels {
        assert!(
            ch.channel_key != Felt::ZERO,
            "Channel key should not be zero"
        );
    }
    for sc in &response.subchannels {
        assert!(sc.token != Felt::ZERO, "Token should not be zero");
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
        decryption_key: metadata.alice_decryption_key,
        last_known_block: None,
        block_ref: None,
        cursor: Default::default(),
    };

    let response1 = indexer.incoming_sync(&request1).await.unwrap();

    // Second sync using block_ref and cursor from previous response
    let request2 = IncomingSyncRequest {
        recipient_address: metadata.alice_address,
        decryption_key: metadata.alice_decryption_key,
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
        recipient_address: metadata.alice_address,
        decryption_key: metadata.alice_decryption_key,
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
    };

    let (status, error) = indexer.incoming_sync_error(&request).await.unwrap();

    // Should return 503 SERVICE_UNAVAILABLE since no head is indexed yet
    assert_eq!(status, 503);
    assert_eq!(error.error.code, "SERVICE_UNAVAILABLE");

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}

#[tokio::test]
async fn test_outgoing_sync_basic() {
    let (devnet, metadata) = setup_devnet_with_dump().await;
    let indexer = setup_indexer(&devnet, Some(&metadata)).await;

    let request = OutgoingSyncRequest {
        sender_address: metadata.alice_address,
        decryption_key: metadata.alice_decryption_key,
        last_known_block: None,
        block_ref: None,
        cursor: Default::default(),
        recipients: None,
    };

    let response = indexer.outgoing_sync(&request).await.unwrap();

    assert!(response.block_ref != Felt::ZERO, "block_ref should be set");

    // Alice has 2 outgoing channels: self-channel (deposit) + Bob (transfer)
    assert_eq!(
        response.channels.len(),
        2,
        "Alice should have 2 outgoing channels (self + Bob)"
    );

    // With a large budget, all discovery should complete
    assert!(
        response.cursor.is_complete(),
        "All discovery should be complete"
    );

    // Each channel should have a matching subchannel with last_note_index = Some(0)
    assert_eq!(
        response.subchannels.len(),
        2,
        "Each channel should have one subchannel"
    );
    for sc in &response.subchannels {
        assert_eq!(
            sc.last_note_index,
            Some(0),
            "Each subchannel should have last_note_index=0"
        );
    }

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}

/// Verifies that passing back a completed cursor is idempotent — the second
/// call returns no new data and the cursor remains complete.
#[tokio::test]
async fn test_outgoing_sync_idempotent() {
    let (devnet, metadata) = setup_devnet_with_dump().await;
    let indexer = setup_indexer(&devnet, Some(&metadata)).await;

    // First sync discovers everything.
    let request1 = OutgoingSyncRequest {
        sender_address: metadata.alice_address,
        decryption_key: metadata.alice_decryption_key,
        last_known_block: None,
        block_ref: None,
        cursor: Default::default(),
        recipients: None,
    };

    let response1 = indexer.outgoing_sync(&request1).await.unwrap();
    assert!(
        response1.cursor.is_complete(),
        "First call should complete all discovery"
    );
    assert_eq!(response1.channels.len(), 2, "Alice has 2 outgoing channels");

    // Second sync with completed cursor — should be a no-op.
    let request2 = OutgoingSyncRequest {
        sender_address: metadata.alice_address,
        decryption_key: metadata.alice_decryption_key,
        last_known_block: None,
        block_ref: Some(response1.block_ref),
        cursor: response1.cursor.clone(),
        recipients: None,
    };

    let response2 = indexer.outgoing_sync(&request2).await.unwrap();
    assert!(
        response2.cursor.is_complete(),
        "Cursor should remain complete"
    );
    assert!(
        response2.channels.is_empty(),
        "No new channels on second call"
    );
    assert!(
        response2.subchannels.is_empty(),
        "No new subchannels on second call"
    );

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}

#[tokio::test]
async fn test_preflight_basic() {
    let (devnet, metadata) = setup_devnet_with_dump().await;
    let indexer = setup_indexer(&devnet, Some(&metadata)).await;

    // Alice→Bob for STRK: all setup complete
    let resp = indexer
        .preflight(&PreflightRequest {
            sender_address: metadata.alice_address,
            decryption_key: metadata.alice_decryption_key,
            recipient: metadata.bob_address,
            token: metadata.strk_token,
        })
        .await
        .unwrap();

    assert!(resp.sender_registered);
    assert!(resp.channel_exists);
    assert!(resp.subchannel_exists);

    // Alice→unknown: recipient not registered, so channel/subchannel can't exist
    let resp2 = indexer
        .preflight(&PreflightRequest {
            sender_address: metadata.alice_address,
            decryption_key: metadata.alice_decryption_key,
            recipient: Felt::from_hex_unchecked("0xdead"),
            token: metadata.strk_token,
        })
        .await
        .unwrap();

    assert!(resp2.sender_registered);
    assert!(!resp2.channel_exists);
    assert!(!resp2.subchannel_exists);

    // Random unregistered sender → all three false
    let resp3 = indexer
        .preflight(&PreflightRequest {
            sender_address: Felt::from_hex_unchecked("0xdead"),
            decryption_key: Felt::from_hex_unchecked("0xbad"),
            recipient: metadata.bob_address,
            token: metadata.strk_token,
        })
        .await
        .unwrap();

    assert!(!resp3.sender_registered);
    assert!(!resp3.channel_exists);
    assert!(!resp3.subchannel_exists);

    indexer.signal_shutdown().unwrap();
    indexer.wait().await.unwrap();
}
