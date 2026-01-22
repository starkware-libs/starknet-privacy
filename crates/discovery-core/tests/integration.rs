//! Integration tests for the RPC storage backend.
//!
//! These tests require an external devnet with a deployed privacy contract.
//!
//! To run:
//! 1. Start devnet:
//!    ```sh
//!    starknet-devnet --lite-mode --seed 42 --state-archive-capacity none --accounts 3 \
//!        --l2-gas-price-fri 1 --data-gas-price-fri 1 --gas-price-fri 1
//!    ```
//! 2. Run the SDK e2e test that performs deposit + transfer
//! 3. Run the tests:
//!    ```sh
//!    cargo test -p discovery-core --test integration -- --ignored --nocapture
//!    ```

use discovery_core::backends::{RpcBackend, RpcConfig};
use discovery_core::storage::{IViews, StorageBackend};
use starknet_core::types::Felt;
use url::Url;

const ALICE_ADDRESS: &str = "0x34ba56f92265f0868c57d3fe72ecab144fc96f97954bbbc4252cef8e8a979ba";
const BOB_ADDRESS: &str = "0x2939f2dc3f80cc7d620e8a86f2e69c1e187b7ff44b74056647368b5c49dc370";
const PRIVACY_CONTRACT: &str = "0xea65c9568637da580c0e38e1fc422e9be44b6d9379f233d19d08ceb9fa8c74";

// Expected values from SDK e2e test
const EXPECTED_COMPLIANCE_KEY: &str = "0x1";
const EXPECTED_ALICE_PUBKEY: &str =
    "0x7913e4dbbc06e873598f6e0bb0076449079fbdd951650c7f7a258d1c6b6a82d";
const EXPECTED_BOB_PUBKEY: &str =
    "0x7c53034b6dea7afaa4ff6317dbf852a6ee8cb88391194e36efaaef406373da4";

const EXPECTED_ALICE_CHANNEL_EPHEMERAL: &str =
    "0x759ca09377679ecd535a81e83039658bf40959283187c654c5416f439403cf5";
const EXPECTED_ALICE_CHANNEL_ENC_KEY: &str =
    "0x2099b7ddf717d3c25d0e7d98d74d11ba7c6d184c522f155cd6d15875a0c692b";
const EXPECTED_ALICE_CHANNEL_ENC_ADDR: &str =
    "0x568f7ff7ae6ff5df27b74162c5bd6fe2f78c39ed649f88979d627e330bc1b88";

const EXPECTED_BOB_CHANNEL_EPHEMERAL: &str =
    "0x759ca09377679ecd535a81e83039658bf40959283187c654c5416f439403cf5";
const EXPECTED_BOB_CHANNEL_ENC_KEY: &str =
    "0x28dac3ac16a798f665ea4a687014202032d386c1f0ade61af5e3e3b632f16b1";
const EXPECTED_BOB_CHANNEL_ENC_ADDR: &str =
    "0x1da4a1948849f8feac06329f827d3d1eae5bea9c9e225a89e3b5d2242d25394";

const EXPECTED_ALICE_ENC_PRIVKEY_EPHEMERAL: &str =
    "0x7f524701a1277e1d8cfd58e885bb67385d37ee2813979ef8424de1869be8878";
const EXPECTED_ALICE_ENC_PRIVKEY: &str =
    "0x91cf1f23db5bed88f30a0c1df6b4bae4c54a65cea77508b941917cd9bf204b";

fn get_rpc_url() -> String {
    std::env::var("STARKNET_RPC_URL").unwrap_or_else(|_| "http://localhost:5050".to_string())
}

fn create_backend() -> RpcBackend {
    RpcBackend::new(RpcConfig {
        rpc_url: Url::parse(&get_rpc_url()).expect("Invalid RPC URL"),
        contract_address: Felt::from_hex(PRIVACY_CONTRACT).unwrap(),
    })
}

/// Verifies storage state after the e2e flow:
/// 1. Alice approves privacy contract to spend 100 STRK
/// 2. Bob registers his public key
/// 3. Alice: autoRegister, deposit 100 STRK, transfer 50 STRK to Bob
///
/// Expected state:
/// - Alice: public key set, 1 channel (50 STRK change)
/// - Bob: public key set, 1 channel (50 STRK received)
/// - Compliance public key set
#[tokio::test]
#[ignore]
async fn test_e2e_flow() {
    let backend = create_backend();
    let snapshot = backend.snapshot(None).await.unwrap();

    let alice = Felt::from_hex(ALICE_ADDRESS).unwrap();
    let bob = Felt::from_hex(BOB_ADDRESS).unwrap();

    // Compliance public key
    let compliance_key = snapshot.get_compliance_public_key().await.unwrap();
    assert_eq!(
        compliance_key,
        Felt::from_hex(EXPECTED_COMPLIANCE_KEY).unwrap(),
        "Compliance key mismatch"
    );

    // Alice's public key
    let alice_pubkey = snapshot.get_public_key(alice).await.unwrap();
    assert_eq!(
        alice_pubkey,
        Felt::from_hex(EXPECTED_ALICE_PUBKEY).unwrap(),
        "Alice public key mismatch"
    );

    // Bob's public key
    let bob_pubkey = snapshot.get_public_key(bob).await.unwrap();
    assert_eq!(
        bob_pubkey,
        Felt::from_hex(EXPECTED_BOB_PUBKEY).unwrap(),
        "Bob public key mismatch"
    );

    // Alice's channels
    let alice_num_channels = snapshot.get_num_of_channels(alice).await.unwrap();
    assert_eq!(alice_num_channels, 1, "Alice should have 1 channel");

    let alice_channel = snapshot.get_channel_info(alice, 0).await.unwrap();
    assert_eq!(
        alice_channel.ephemeral_pubkey,
        Felt::from_hex(EXPECTED_ALICE_CHANNEL_EPHEMERAL).unwrap(),
        "Alice channel ephemeral mismatch"
    );
    assert_eq!(
        alice_channel.enc_channel_key,
        Felt::from_hex(EXPECTED_ALICE_CHANNEL_ENC_KEY).unwrap(),
        "Alice channel enc_key mismatch"
    );
    assert_eq!(
        alice_channel.enc_sender_addr,
        Felt::from_hex(EXPECTED_ALICE_CHANNEL_ENC_ADDR).unwrap(),
        "Alice channel enc_addr mismatch"
    );

    // Bob's channels
    let bob_num_channels = snapshot.get_num_of_channels(bob).await.unwrap();
    assert_eq!(bob_num_channels, 1, "Bob should have 1 channel");

    let bob_channel = snapshot.get_channel_info(bob, 0).await.unwrap();
    assert_eq!(
        bob_channel.ephemeral_pubkey,
        Felt::from_hex(EXPECTED_BOB_CHANNEL_EPHEMERAL).unwrap(),
        "Bob channel ephemeral mismatch"
    );
    assert_eq!(
        bob_channel.enc_channel_key,
        Felt::from_hex(EXPECTED_BOB_CHANNEL_ENC_KEY).unwrap(),
        "Bob channel enc_key mismatch"
    );
    assert_eq!(
        bob_channel.enc_sender_addr,
        Felt::from_hex(EXPECTED_BOB_CHANNEL_ENC_ADDR).unwrap(),
        "Bob channel enc_addr mismatch"
    );

    // Alice's encrypted private key
    let alice_enc_key = snapshot.get_enc_private_key(alice).await.unwrap();
    assert_eq!(
        alice_enc_key.ephemeral_pubkey,
        Felt::from_hex(EXPECTED_ALICE_ENC_PRIVKEY_EPHEMERAL).unwrap(),
        "Alice enc_private_key ephemeral mismatch"
    );
    assert_eq!(
        alice_enc_key.enc_private_key,
        Felt::from_hex(EXPECTED_ALICE_ENC_PRIVKEY).unwrap(),
        "Alice enc_private_key mismatch"
    );
}
