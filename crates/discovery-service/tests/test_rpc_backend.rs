//! RPC backend integration tests.
//!
//! ## Running tests
//!
//! ```sh
//! cargo test -p discovery-service --test test_rpc_backend
//! ```
//!
//! ## Updating snapshots
//!
//! When expected values change, update snapshots with:
//! ```sh
//! UPDATE_EXPECT=1 cargo test -p discovery-service --test test_rpc_backend
//! ```

mod common;

use std::path::Path;

use common::{DevnetClient, DevnetConfig, DumpMetadata};
use discovery_core::privacy_pool::views::IViews;
use discovery_core::storage_backend::StorageBackend;
use discovery_service::rpc_backend::{RpcBackend, RpcConfig};
use expect_test::expect;
use starknet_core::types::Felt;
use url::Url;

const FIXTURES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

async fn setup_devnet() -> (DevnetClient, DumpMetadata) {
    let mut devnet = DevnetClient::spawn(DevnetConfig {
        seed: 42,
        accounts: 3,
        ..Default::default()
    })
    .expect("failed to spawn devnet");

    let metadata = devnet
        .load_dump(Path::new(FIXTURES_DIR))
        .await
        .expect("failed to load dump");

    (devnet, metadata)
}

#[tokio::test]
async fn test_public_key_lookup() {
    let (devnet, metadata) = setup_devnet().await;

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
