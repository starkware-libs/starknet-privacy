//! Covers the Primer pattern the anonymizer deploys shadow accounts with: deploy a primer, replace
//! its class with the shadow account's, then initialize it.
//!
//! `replace_class_syscall` does not run constructors, so the shadow account's constructor never
//! records an owner and the explicit `initialize` call is what makes the account usable. The tests
//! here pin that requirement down, alongside the address stability the pattern exists to provide.

use core::num::traits::Zero;
use shadow_account_anonymizer::shadow_account_anonymizer::{
    IShadowAccountAnonymizerDispatcherTrait, PRIMER_CLASS_HASH, commitment_from_partial,
};
use shadow_account_anonymizer::tests::test_utils::{
    ComponentsTrait, anonymizer_disp, deploy_components,
};
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare, get_class_hash};
use starknet::account::Call;
use starknet::{ContractAddress, SyscallResultTrait, get_contract_address};
use starkware_accounts::account_factory::{IPrimerDispatcher, IPrimerDispatcherTrait};
use starkware_accounts::shadow_account::{IShadowAccountDispatcher, IShadowAccountDispatcherTrait};

/// The user+dapp half of the commitments used across these tests.
const PARTIAL_COMMITMENT: felt252 = 'PARTIAL_COMMITMENT';

/// Guard: the anonymizer derives shadow account addresses from `PRIMER_CLASS_HASH` at compile time,
/// so the constant must equal the class hash of the primer the build actually deploys. Update the
/// `cfg(target: "test")` constant to the value reported here if the mock's hash shifts.
#[test]
fn test_primer_class_hash_matches_deployed_primer() {
    let primer_class_hash = *declare("PrimerMock").unwrap_syscall().contract_class().class_hash;
    assert!(
        primer_class_hash == PRIMER_CLASS_HASH,
        "PrimerMock class hash {:?} != PRIMER_CLASS_HASH {:?}",
        primer_class_hash,
        PRIMER_CLASS_HASH,
    );
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

/// The whole point of the pattern: the address a commitment resolves to does not depend on the
/// shadow account class, so changing that class leaves already-advertised addresses intact.
#[test]
fn test_predicted_address_survives_a_shadow_account_class_change() {
    let components = deploy_components();
    let anonymizer = anonymizer_disp(components.anonymizer);
    let predicted = anonymizer
        .get_shadow_accounts(
            partial_commitment: PARTIAL_COMMITMENT,
            start_nonce: 0,
            end_nonce: 1,
            until_undeployed: false,
        );
    assert!(!*predicted[0].is_deployed);

    let commitment = commitment_from_partial(PARTIAL_COMMITMENT, 0);
    components
        .invoke(identity_commitment: commitment, calls: array![], open_notes: array![].span());

    assert!(anonymizer.get_shadow_account(commitment) == *predicted[0].address);
}

/// Deploys a primer and replaces its class with the shadow account's, without initializing it.
fn deploy_shadow_account_via_primer() -> ContractAddress {
    let primer_class = declare("PrimerMock").unwrap_syscall().contract_class();
    let (primer_address, _) = primer_class.deploy(@array![]).unwrap_syscall();
    IPrimerDispatcher { contract_address: primer_address }
        .set_class_hash(
            new_class_hash: *declare("ShadowAccount").unwrap_syscall().contract_class().class_hash,
        );
    primer_address
}
