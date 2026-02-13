//! API server integration tests.
//!
//! ## Running tests
//!
//! ```sh
//! cargo test -p discovery-service --test test_api
//! ```

mod common;

use std::time::Duration;

use common::{find_free_port, DevnetClient, DevnetConfig, IndexerClient};
use discovery_service::api::HealthResponse;

const BINARY: &str = env!("CARGO_BIN_EXE_discovery-service");

#[tokio::test]
async fn test_health_endpoint_returns_ok() {
    let devnet = DevnetClient::spawn(DevnetConfig::default()).expect("Failed to spawn devnet");
    let api_port = find_free_port().expect("Failed to find free port");
    let api_host = format!("127.0.0.1:{}", api_port);

    let mut indexer = IndexerClient::spawn_with_binary(BINARY, &devnet.ws_url(), Some(&api_host))
        .await
        .expect("Failed to spawn indexer");

    // Wait for API server to be ready and indexer to subscribe.
    // These happen concurrently so we must wait for both in any order.
    indexer
        .wait_for_logs(
            &["API server listening", "Subscribed to new heads"],
            Duration::from_secs(10),
        )
        .await
        .unwrap();

    // Create a block so there's a chain head
    devnet.create_block().await.unwrap();
    indexer
        .wait_for_log("New block #", Duration::from_secs(5))
        .await
        .unwrap();

    // Call the health endpoint
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
