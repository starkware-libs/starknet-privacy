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
use discovery_core::privacy_pool::events::{IEvents, PrivacyPoolEventContent};
use discovery_core::privacy_pool::views::IViews;
use discovery_core::storage_backend::StorageBackend;
use discovery_service::chain_state::ChainState;
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

    let snapshot = backend.snapshot(metadata.contract_address, None).await;

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

#[tokio::test]
async fn test_block_events() {
    let (devnet, metadata) = setup_devnet_with_dump().await;

    let backend = RpcBackend::new(RpcConfig {
        url: devnet.rpc_url(),
        ..Default::default()
    })
    .unwrap();
    let head_block = backend.get_head().await.unwrap().block_number;
    let snapshot = backend.snapshot(metadata.contract_address, None).await;

    // Collect all events across all blocks in the devnet fixture.
    let mut all_events = Vec::new();
    for block_number in 0..=head_block {
        let events = snapshot.get_block_events(block_number).await.unwrap();
        all_events.extend(events);
    }

    // Devnet scenario: deposit 100 + transfer 50 to Bob, then Bob withdraws 50.
    // Expected events: 1 Deposit, 2 EncNoteCreated, 1 Withdrawal (at minimum).
    let deposit_count = all_events
        .iter()
        .filter(|e| matches!(e.content, PrivacyPoolEventContent::Deposit(_)))
        .count();
    let withdrawal_count = all_events
        .iter()
        .filter(|e| matches!(e.content, PrivacyPoolEventContent::Withdrawal(_)))
        .count();
    let note_created_count = all_events
        .iter()
        .filter(|e| matches!(e.content, PrivacyPoolEventContent::EncNoteCreated(_)))
        .count();

    assert!(deposit_count >= 1, "expected at least 1 Deposit event");
    assert!(
        withdrawal_count >= 1,
        "expected at least 1 Withdrawal event"
    );
    assert!(
        note_created_count >= 2,
        "expected at least 2 EncNoteCreated events"
    );
}

#[tokio::test]
async fn test_withdrawal_events() {
    let (devnet, metadata) = setup_devnet_with_dump().await;

    let backend = RpcBackend::new(RpcConfig {
        url: devnet.rpc_url(),
        ..Default::default()
    })
    .unwrap();
    let head_block = backend.get_head().await.unwrap().block_number;
    let snapshot = backend.snapshot(metadata.contract_address, None).await;

    let withdrawals = snapshot
        .get_withdrawal_events(metadata.bob_address, 0, head_block)
        .await
        .unwrap();

    assert_eq!(withdrawals.len(), 1);
    let PrivacyPoolEventContent::Withdrawal(withdrawal) = &withdrawals[0].content else {
        panic!("expected Withdrawal event");
    };
    assert_eq!(withdrawal.to_address, metadata.bob_address);
    assert_eq!(withdrawal.token, metadata.strk_token);
    assert_eq!(withdrawal.amount, 50);
}

#[tokio::test]
async fn test_withdrawal_events_empty_for_non_recipient() {
    let (devnet, metadata) = setup_devnet_with_dump().await;

    let backend = RpcBackend::new(RpcConfig {
        url: devnet.rpc_url(),
        ..Default::default()
    })
    .unwrap();
    let head_block = backend.get_head().await.unwrap().block_number;
    let snapshot = backend.snapshot(metadata.contract_address, None).await;

    // Alice is not a withdrawal recipient in the devnet scenario
    let withdrawals = snapshot
        .get_withdrawal_events(metadata.alice_address, 0, head_block)
        .await
        .unwrap();

    assert!(withdrawals.is_empty());
}
