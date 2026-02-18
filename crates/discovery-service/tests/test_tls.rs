//! TLS integration test: verify the service can terminate TLS with a self-signed certificate.
//!
//! Run with: `cargo test -p discovery-service --test test_tls`

mod common;

use std::time::Duration;

use common::{DevnetClient, DevnetConfig, IndexerClient, IndexerSpawnConfig};

/// Generate a self-signed certificate and key, write them to a temp directory,
/// and return the (cert_path, key_path) as strings.
fn generate_self_signed_cert(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let key_pair = rcgen::KeyPair::generate().expect("failed to generate key pair");
    let cert =
        rcgen::CertificateParams::new(vec!["127.0.0.1".to_string(), "localhost".to_string()])
            .expect("failed to create cert params")
            .self_signed(&key_pair)
            .expect("failed to self-sign certificate");

    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");

    std::fs::write(&cert_path, cert.pem()).expect("failed to write cert");
    std::fs::write(&key_path, key_pair.serialize_pem()).expect("failed to write key");

    (cert_path, key_path)
}

#[tokio::test]
async fn test_tls_health_endpoint() {
    let temp_dir = tempfile::tempdir().expect("failed to create temp dir");
    let (cert_path, key_path) = generate_self_signed_cert(temp_dir.path());

    let devnet = DevnetClient::spawn(DevnetConfig::default()).expect("Failed to spawn devnet");

    let mut indexer = IndexerClient::spawn(
        env!("CARGO_BIN_EXE_discovery-service"),
        IndexerSpawnConfig {
            ws_url: devnet.ws_url(),
            tls_cert_path: Some(cert_path.to_str().unwrap().to_string()),
            tls_key_path: Some(key_path.to_str().unwrap().to_string()),
            ..Default::default()
        },
    )
    .await
    .expect("Failed to spawn indexer with TLS");

    indexer
        .wait_until_ready(&devnet)
        .await
        .expect("Indexer not ready");

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .expect("failed to build HTTPS client");

    let response = client
        .get(format!("{}/health", indexer.base_url()))
        .send()
        .await
        .expect("failed to reach /health over HTTPS");

    assert_eq!(response.status(), 200);

    // Verify plain HTTP does NOT work on the same port
    let plain_client = reqwest::Client::new();
    let plain_result = plain_client
        .get(format!("http://{}/health", indexer.api_host()))
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    assert!(
        plain_result.is_err(),
        "plain HTTP should not work when TLS is enabled"
    );
}
