//! Integration tests for RpcBackend against local devnet.
//!
//! ## Running tests
//!
//! ```sh
//! cargo test -p discovery-service --test integration
//! ```
//!
//! ## Updating snapshots
//!
//! When expected values change, update snapshots with:
//! ```sh
//! UPDATE_EXPECT=1 cargo test -p discovery-service --test integration
//! ```

mod common;

use common::{Devnet, DevnetConfig};
use discovery_core::storage::{IViews, StorageBackend};
use discovery_service::rpc_backend::{RpcBackend, RpcConfig};
use expect_test::expect;
use serde::Deserialize;
use starknet_core::types::Felt;
use url::Url;

const DUMP_GZ: &[u8] = include_bytes!("fixtures/devnet-dump.json.gz");
const METADATA: &str = include_str!("fixtures/devnet-dump.metadata.json");

/// Metadata with contract addresses from devnet dump.
#[derive(Deserialize)]
struct Metadata {
    contract_address: Felt,
    alice_address: Felt,
}

fn load_metadata() -> Metadata {
    serde_json::from_str(METADATA).expect("failed to parse metadata")
}

async fn spawn_devnet() -> Devnet {
    let mut devnet = Devnet::spawn(DevnetConfig {
        seed: 42,
        accounts: 3,
    })
    .expect("failed to spawn devnet");
    devnet
        .load_dump_bytes(DUMP_GZ)
        .await
        .expect("failed to load dump");
    devnet
}

#[tokio::test]
async fn test_public_key_lookup() {
    let devnet = spawn_devnet().await;
    let metadata = load_metadata();

    let backend = RpcBackend::new(RpcConfig::new(
        Url::parse(&devnet.rpc_url()).unwrap(),
        metadata.contract_address,
    ))
    .unwrap();

    let snapshot = backend.snapshot(None).await.unwrap();

    // Alice should have a registered public key
    let alice_pubkey = snapshot
        .get_public_key(metadata.alice_address)
        .await
        .unwrap();
    expect![[r#"
        0x07913e4dbbc06e873598f6e0bb0076449079fbdd951650c7f7a258d1c6b6a82d
    "#]]
    .assert_eq(&format!("{:#066x}\n", alice_pubkey));

    // Random address should have no public key (zero)
    let random_pubkey = snapshot
        .get_public_key(Felt::from_hex("0xdeadbeef").unwrap())
        .await
        .unwrap();
    assert_eq!(random_pubkey, Felt::ZERO);
}
