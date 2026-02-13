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

use common::setup_devnet_with_dump;
use discovery_core::privacy_pool::views::IViews;
use discovery_core::storage_backend::StorageBackend;
use discovery_service::config::RpcConfig;
use discovery_service::rpc_backend::RpcBackend;
use expect_test::expect;
use starknet_core::types::Felt;

#[tokio::test]
async fn test_public_key_lookup() {
    let (devnet, metadata) = setup_devnet_with_dump().await;

    let rpc_config = RpcConfig {
        url: devnet.rpc_url(),
        ..Default::default()
    };
    let backend = RpcBackend::new(rpc_config).unwrap();

    let snapshot = backend
        .snapshot(metadata.contract_address, None)
        .await
        .unwrap();

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
