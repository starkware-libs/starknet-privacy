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
use starknet_core::types::Felt;
use url::Url;

const DUMP_GZ: &[u8] = include_bytes!("fixtures/devnet-dump.json.gz");

async fn setup_devnet() -> (Devnet, Felt, Felt) {
    let mut devnet = Devnet::spawn(DevnetConfig {
        seed: 42,
        accounts: 3,
    })
    .expect("failed to spawn devnet");
    devnet
        .load_dump_bytes(DUMP_GZ)
        .await
        .expect("failed to load dump");

    let accounts = devnet
        .get_predeployed_accounts()
        .await
        .expect("failed to get accounts");
    let alice_address = accounts[0].address;

    let contracts = devnet
        .get_deployed_contracts()
        .await
        .expect("failed to get contracts");
    let contract_address = contracts[0].address;

    (devnet, contract_address, alice_address)
}

#[tokio::test]
async fn test_public_key_lookup() {
    let (devnet, contract_address, alice_address) = setup_devnet().await;

    let backend = RpcBackend::new(RpcConfig::new(
        Url::parse(&devnet.rpc_url()).unwrap(),
        contract_address,
    ))
    .unwrap();

    let snapshot = backend.snapshot(None).await.unwrap();

    // Alice should have a registered public key
    let alice_pubkey = snapshot.get_public_key(alice_address).await.unwrap();
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
