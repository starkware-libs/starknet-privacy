//! API server tests: health endpoint.
//!
//! Run with: `cargo test -p discovery-service --test test_api`

mod common;

use common::{setup_indexer, DevnetClient, DevnetConfig};
use discovery_service::api_server::HealthResponse;

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
