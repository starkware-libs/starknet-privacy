use shadow_account_anonymizer::shadow_account_anonymizer::{
    IShadowAccountAnonymizerDispatcherTrait, IdentityCommitment, PartialCommitment,
    commitment_from_partial,
};
use shadow_account_anonymizer::test_utils_contracts::shadow_account_registry_mock::{
    IShadowAccountRegistryMockDispatcher, IShadowAccountRegistryMockDispatcherTrait,
};
use shadow_account_anonymizer::tests::test_utils::{
    ComponentsTrait, anonymizer_disp, declare_class, deploy_components, run_eic_upgrade,
};
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use starknet::{ClassHash, ContractAddress, SyscallResultTrait};
use starkware_utils::components::replaceability::interface::{
    IEICInitializableDispatcher, IEICInitializableDispatcherTrait,
};

/// The user+dapp half of the commitments used across these tests.
const PARTIAL_COMMITMENT: PartialCommitment = 'PARTIAL_COMMITMENT';

/// The pre-rename registry entries seeded into the mock, in insertion order.
fn seeded_sub_accounts() -> Array<(IdentityCommitment, ContractAddress)> {
    array![
        ('COMMITMENT_0', 'SHADOW_ACCOUNT_0'.try_into().unwrap()),
        ('COMMITMENT_1', 'SHADOW_ACCOUNT_1'.try_into().unwrap()),
        ('COMMITMENT_2', 'SHADOW_ACCOUNT_2'.try_into().unwrap()),
    ]
}

#[test]
fn test_migrates_registry_verbatim() {
    let registry = deploy_seeded_registry_mock();
    registry.run_eic(eic_class_hash: migration_eic_class_hash(), eic_init_data: array![].span());

    // Same commitments, same addresses, same order.
    assert!(registry.get_shadow_accounts() == seeded_sub_accounts().span());
    // The pre-rename registry is copied, not moved.
    assert!(registry.get_sub_accounts() == seeded_sub_accounts().span());
}

#[test]
fn test_migrating_twice_adds_no_duplicates() {
    let registry = deploy_seeded_registry_mock();
    registry.run_eic(eic_class_hash: migration_eic_class_hash(), eic_init_data: array![].span());
    registry.run_eic(eic_class_hash: migration_eic_class_hash(), eic_init_data: array![].span());

    assert!(registry.get_shadow_accounts() == seeded_sub_accounts().span());
}

#[test]
fn test_migrates_empty_registry() {
    let registry = deploy_registry_mock();
    registry.run_eic(eic_class_hash: migration_eic_class_hash(), eic_init_data: array![].span());

    assert!(registry.get_shadow_accounts().is_empty());
}

#[test]
fn test_migration_upgrade_keeps_deployed_shadow_accounts() {
    // The live anonymizer has no pre-rename registry to copy, so running the migration through a
    // real upgrade must leave the shadow accounts it already recorded untouched.
    let components = deploy_components();
    let anonymizer = components.anonymizer;
    let commitment = commitment_from_partial(PARTIAL_COMMITMENT, 0);
    components
        .invoke(identity_commitment: commitment, calls: array![], open_notes: array![].span());
    let shadow_account = anonymizer_disp(anonymizer).get_shadow_account(commitment);

    run_eic_upgrade(
        :anonymizer, eic_name: "ShadowAccountsMigrationEIC", eic_init_data: array![].span(),
    );

    assert!(anonymizer_disp(anonymizer).get_shadow_account(commitment) == shadow_account);
}

#[test]
#[should_panic(expected: 'INVALID_INIT_DATA_LEN')]
fn test_eic_initialize_rejects_init_data() {
    let contract = declare("ShadowAccountsMigrationEIC").unwrap_syscall().contract_class();
    let (contract_address, _) = contract.deploy(@array![]).unwrap_syscall();
    IEICInitializableDispatcher { contract_address }.eic_initialize(array![0].span());
}

fn deploy_seeded_registry_mock() -> IShadowAccountRegistryMockDispatcher {
    let registry = deploy_registry_mock();
    for (identity_commitment, sub_account) in seeded_sub_accounts() {
        registry.set_sub_account(:identity_commitment, :sub_account);
    }
    registry
}

fn deploy_registry_mock() -> IShadowAccountRegistryMockDispatcher {
    let contract = declare("ShadowAccountRegistryMock").unwrap_syscall().contract_class();
    let (contract_address, _) = contract.deploy(@array![]).unwrap_syscall();
    IShadowAccountRegistryMockDispatcher { contract_address }
}

fn migration_eic_class_hash() -> ClassHash {
    declare_class("ShadowAccountsMigrationEIC")
}
