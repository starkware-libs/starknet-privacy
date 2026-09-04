//! Covers the Primer pattern the anonymizer deploys shadow accounts with: deploy a primer, replace
//! its class with the shadow account's, then initialize it.
//!
//! `replace_class_syscall` does not run constructors, so the shadow account's constructor never
//! records an owner and the explicit `initialize` call is what makes the account usable. The tests
//! here pin that requirement down, alongside the address stability the pattern exists to provide.

use core::num::traits::Zero;
use openzeppelin::utils::deployments::calculate_contract_address_from_deploy_syscall;
use shadow_account_anonymizer::shadow_account_anonymizer::{
    IShadowAccountAnonymizerDispatcherTrait, PRIMER_CLASS_HASH, commitment_from_partial,
};
use shadow_account_anonymizer::test_utils_contracts::shadow_account_registry_mock::ShadowAccountRegistryMock;
use shadow_account_anonymizer::tests::test_utils::{
    ComponentsTrait, anonymizer_disp, declare_primer, deploy_components,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, get_class_hash, interact_with_state, store,
};
use starknet::account::Call;
use starknet::{ContractAddress, SyscallResultTrait, get_contract_address};
use starkware_accounts::account_factory::{IPrimerDispatcher, IPrimerDispatcherTrait};
use starkware_accounts::shadow_account::{IShadowAccountDispatcher, IShadowAccountDispatcherTrait};
use starkware_utils::storage::iterable_map::IterableMapWriteAccessImpl;

/// The user+dapp half of the commitments used across these tests.
const PARTIAL_COMMITMENT: felt252 = 'PARTIAL_COMMITMENT';

/// Guard: the anonymizer derives shadow account addresses from `PRIMER_CLASS_HASH` at compile time,
/// so the artifact the tests declare must be exactly that cemented class.
#[test]
fn test_vendored_primer_is_the_cemented_class() {
    assert!(declare_primer().class_hash == PRIMER_CLASS_HASH);
}

/// Replacing the primer's class leaves the shadow account unowned: its constructor never runs.
#[test]
fn test_shadow_account_is_unowned_until_initialized() {
    let shadow_account = deploy_shadow_account_via_primer();

    let owner = IShadowAccountDispatcher { contract_address: shadow_account }.owner();
    assert!(owner == Zero::zero(), "expected an unowned account, got owner {:?}", owner);
}

/// With no owner recorded, `execute` reverts for every caller.
#[test]
#[should_panic(expected: 'SHADOW_ACCOUNT: NOT OWNER')]
fn test_uninitialized_shadow_account_cannot_execute() {
    let shadow_account = deploy_shadow_account_via_primer();

    let calls: Array<Call> = array![];
    IShadowAccountDispatcher { contract_address: shadow_account }.execute(calls);
}

/// `initialize` records its caller, so the anonymizer ends up owning the accounts it deploys.
#[test]
fn test_initialize_records_the_caller_as_owner() {
    let shadow_account = deploy_shadow_account_via_primer();
    let shadow_account_disp = IShadowAccountDispatcher { contract_address: shadow_account };
    shadow_account_disp.initialize();

    assert!(shadow_account_disp.owner() == get_contract_address());
}

/// A deployed shadow account cannot be re-owned by a later `initialize`.
#[test]
#[should_panic(expected: 'SHADOW_ACCOUNT: INITIALIZED')]
fn test_initialize_twice_reverts() {
    let shadow_account = deploy_shadow_account_via_primer();
    let shadow_account_disp = IShadowAccountDispatcher { contract_address: shadow_account };
    shadow_account_disp.initialize();

    shadow_account_disp.initialize();
}

/// The anonymizer's own deployment path produces an account it owns and can drive.
#[test]
fn test_anonymizer_owns_the_shadow_accounts_it_deploys() {
    let components = deploy_components();
    let commitment = commitment_from_partial(PARTIAL_COMMITMENT, 0);
    components
        .invoke(identity_commitment: commitment, calls: array![], open_notes: array![].span());

    let shadow_account = anonymizer_disp(components.anonymizer).get_shadow_account(commitment);
    let owner = IShadowAccountDispatcher { contract_address: shadow_account }.owner();
    assert!(owner == components.anonymizer, "expected anonymizer to own it, got {:?}", owner);
}

/// The deployed account runs the shadow account class, not the primer it was deployed from.
#[test]
fn test_deployed_shadow_account_runs_the_configured_class() {
    let components = deploy_components();
    let commitment = commitment_from_partial(PARTIAL_COMMITMENT, 0);
    components
        .invoke(identity_commitment: commitment, calls: array![], open_notes: array![].span());
    let anonymizer = anonymizer_disp(components.anonymizer);

    let shadow_account = anonymizer.get_shadow_account(commitment);
    assert!(get_class_hash(shadow_account) == anonymizer.get_shadow_account_class_hash());
}

/// The essence of the primer pattern: a shadow account's address depends on primer's class,
/// not on the account class it ends up running.
/// Two accounts deployed either side of a `shadow_account_class_hash` change
/// must both land on the address predicted before either existed.
#[test]
fn test_predicted_address_survives_a_shadow_account_class_change() {
    let components = deploy_components();
    let anonymizer = anonymizer_disp(components.anonymizer);

    // Predict addresses up front, before accounts are deployed.
    let predicted = anonymizer
        .get_shadow_accounts(
            partial_commitment: PARTIAL_COMMITMENT,
            start_nonce: 0,
            end_nonce: 2,
            until_undeployed: false,
        );
    assert!(!*predicted[0].is_deployed);
    assert!(!*predicted[1].is_deployed);

    // Deploy the first account on the original class.
    let first_class_hash = anonymizer.get_shadow_account_class_hash();
    let first_commitment = commitment_from_partial(PARTIAL_COMMITMENT, 0);
    components
        .invoke(
            identity_commitment: first_commitment, calls: array![], open_notes: array![].span(),
        );

    // Change the account class hash stored in the anonymizer,
    // then deploy the second account.
    let second_class_hash = *declare("MockShadowAccount")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    assert!(second_class_hash != first_class_hash, "clash clash");
    store(
        target: components.anonymizer,
        storage_address: selector!("shadow_account_class_hash"),
        serialized_value: array![second_class_hash.into()].span(),
    );
    let second_commitment = commitment_from_partial(PARTIAL_COMMITMENT, 1);
    components
        .invoke(
            identity_commitment: second_commitment, calls: array![], open_notes: array![].span(),
        );

    // The class change really took effect, so the address stability below is not vacuous.
    let first_account = anonymizer.get_shadow_account(first_commitment);
    let second_account = anonymizer.get_shadow_account(second_commitment);
    assert_eq!(get_class_hash(first_account), first_class_hash);
    assert_eq!(get_class_hash(second_account), second_class_hash);

    // Both accounts landed exactly where they were predicted, across the class change.
    assert_eq!(first_account, *predicted[0].address);
    assert_eq!(second_account, *predicted[1].address);
}

/// Pins the derivation itself: a shadow account's address is the deploy-syscall address for the
/// identity commitment as salt, the cemented primer class, empty constructor calldata, and the
/// anonymizer as deployer.
///
/// Every other address test compares the contract against itself, the address it predicts
/// against the address it deploys to, so all four inputs could change together and still agree.
/// This is what holds them to the derivation off-chain callers reproduce.
#[test]
fn test_computed_address_follows_the_primer_derivation() {
    let components = deploy_components();
    let anonymizer = anonymizer_disp(components.anonymizer);
    let commitment = commitment_from_partial(PARTIAL_COMMITMENT, 0);

    let predicted = *anonymizer
        .get_shadow_accounts(
            partial_commitment: PARTIAL_COMMITMENT,
            start_nonce: 0,
            end_nonce: 1,
            until_undeployed: false,
        )[0]
        .address;
    assert_eq!(
        predicted,
        calculate_contract_address_from_deploy_syscall(
            salt: commitment,
            class_hash: PRIMER_CLASS_HASH,
            constructor_calldata: array![].span(),
            deployer_address: components.anonymizer,
        ),
    );

    // And the account really does deploy there.
    components
        .invoke(identity_commitment: commitment, calls: array![], open_notes: array![].span());
    assert_eq!(anonymizer.get_shadow_account(commitment), predicted);
}

/// Shadow accounts deployed before the primer transition came straight from the account class, so
/// their addresses do not match the primer derivation. The recorded address stays authoritative:
/// the views must return what is stored, never a recomputation, or those accounts become
/// unreachable along with the funds they hold.
#[test]
fn test_pre_primer_shadow_account_resolves_to_its_stored_address() {
    let components = deploy_components();
    let anonymizer = anonymizer_disp(components.anonymizer);
    let commitment = commitment_from_partial(PARTIAL_COMMITMENT, 0);
    let computed_address = *anonymizer
        .get_shadow_accounts(
            partial_commitment: PARTIAL_COMMITMENT,
            start_nonce: 0,
            end_nonce: 1,
            until_undeployed: false,
        )[0]
        .address;

    // Deploy the way the anonymizer used to: straight from the account class, whose constructor
    // records the owner. Its address derives from that class, so it is not the primer-derived one.
    let (legacy_account, _) = declare("ShadowAccount")
        .unwrap_syscall()
        .contract_class()
        .deploy(@array![])
        .unwrap_syscall();
    assert!(
        legacy_account != computed_address,
        "the legacy account must not sit on the primer-derived address",
    );

    // Record it against the commitment, as a pre-primer deployment would have.
    interact_with_state(
        components.anonymizer,
        || {
            let mut registry = ShadowAccountRegistryMock::contract_state_for_testing();
            registry.shadow_accounts.write(commitment, legacy_account);
        },
    );

    assert_eq!(anonymizer.get_shadow_account(commitment), legacy_account);
    let info = *anonymizer
        .get_shadow_accounts(
            partial_commitment: PARTIAL_COMMITMENT,
            start_nonce: 0,
            end_nonce: 1,
            until_undeployed: false,
        )[0];
    assert!(info.is_deployed);
    assert_eq!(info.address, legacy_account);
}

/// Deploys a primer and replaces its class with the shadow account's, without initializing it.
fn deploy_shadow_account_via_primer() -> ContractAddress {
    let (primer_address, _) = declare_primer().deploy(@array![]).unwrap_syscall();
    IPrimerDispatcher { contract_address: primer_address }
        .set_class_hash(
            new_class_hash: *declare("ShadowAccount").unwrap_syscall().contract_class().class_hash,
        );
    primer_address
}
