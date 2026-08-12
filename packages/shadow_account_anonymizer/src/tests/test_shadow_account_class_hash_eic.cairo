use openzeppelin::utils::deployments::calculate_contract_address_from_deploy_syscall;
use shadow_account_anonymizer::shadow_account_anonymizer::{
    IShadowAccountAnonymizerDispatcherTrait, PartialCommitment, commitment_from_partial,
};
use shadow_account_anonymizer::tests::test_utils::{
    ComponentsTrait, PRIVACY, anonymizer_disp, declare_class,
    deploy_anonymizer_with_shadow_account_class, deploy_components, run_eic_upgrade,
};
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare, get_class_hash};
use starknet::{ClassHash, ContractAddress, SyscallResultTrait};
use starkware_utils::components::replaceability::interface::{
    IEICInitializableDispatcher, IEICInitializableDispatcherTrait,
};
use starkware_utils_testing::test_utils::cheat_caller_address_once;

/// The user+dapp half of the commitments used across these tests.
const PARTIAL_COMMITMENT: PartialCommitment = 'PARTIAL_COMMITMENT';

#[test]
fn test_eic_replaces_shadow_account_class_hash() {
    let components = deploy_components();
    let anonymizer = components.anonymizer;
    let commitment = commitment_from_partial(PARTIAL_COMMITMENT, 0);
    components
        .invoke(identity_commitment: commitment, calls: array![], open_notes: array![].span());
    let shadow_account = anonymizer_disp(anonymizer).get_shadow_account(commitment);

    let new_class_hash = declare_class("MockDapp");
    replace_shadow_account_class_hash(:anonymizer, :new_class_hash);

    assert!(anonymizer_disp(anonymizer).get_shadow_account_class_hash() == new_class_hash);
    // Shadow accounts deployed before the replacement keep their address and their code.
    assert!(anonymizer_disp(anonymizer).get_shadow_account(commitment) == shadow_account);
    assert!(get_class_hash(shadow_account) == declare_class("SubAccount"));
    // Undeployed shadow accounts resolve to the address the new class hash derives.
    let undeployed_nonce = 1;
    let shadow_accounts = anonymizer_disp(anonymizer)
        .get_shadow_accounts(
            PARTIAL_COMMITMENT,
            start_nonce: undeployed_nonce,
            end_nonce: undeployed_nonce + 1,
            until_undeployed: false,
        );
    assert!(
        *shadow_accounts[0]
            .address == calculate_contract_address_from_deploy_syscall(
                salt: commitment_from_partial(PARTIAL_COMMITMENT, undeployed_nonce.into()),
                class_hash: new_class_hash,
                constructor_calldata: array![].span(),
                deployer_address: anonymizer,
            ),
    );
}

#[test]
fn test_shadow_account_deploys_with_replaced_class_hash() {
    // The anonymizer starts on a class that cannot serve as a shadow account, so deploying and
    // driving one after the replacement can only succeed on the replaced class hash.
    let anonymizer = deploy_anonymizer_with_shadow_account_class(
        shadow_account_class_hash: declare_class("MockDapp"),
    );
    let sub_account_class_hash = declare_class("SubAccount");
    replace_shadow_account_class_hash(:anonymizer, new_class_hash: sub_account_class_hash);

    let commitment = commitment_from_partial(PARTIAL_COMMITMENT, 0);
    cheat_caller_address_once(contract_address: anonymizer, caller_address: PRIVACY);
    anonymizer_disp(anonymizer)
        .privacy_invoke_with_computation(
            identity_commitment: commitment, calls: array![], open_notes: array![].span(),
        );

    let shadow_account = anonymizer_disp(anonymizer).get_shadow_account(commitment);
    assert!(get_class_hash(shadow_account) == sub_account_class_hash);
}

#[test]
#[should_panic(expected: 'INVALID_INIT_DATA_LEN')]
fn test_eic_initialize_empty_init_data() {
    deploy_eic().eic_initialize(array![].span());
}

#[test]
#[should_panic(expected: 'INVALID_INIT_DATA_LEN')]
fn test_eic_initialize_extra_init_data() {
    let class_hash: felt252 = declare_class("SubAccount").into();
    deploy_eic().eic_initialize(array![class_hash, class_hash].span());
}

#[test]
#[should_panic(expected: 'INVALID_CLASS_HASH')]
fn test_eic_initialize_zero_class_hash() {
    deploy_eic().eic_initialize(array![0].span());
}

#[test]
#[should_panic(expected: 'INVALID_CLASS_HASH')]
fn test_eic_initialize_out_of_range_class_hash() {
    // Class hashes are bounded well below the felt modulus, so -1 is not a valid one.
    deploy_eic().eic_initialize(array![-1].span());
}

fn replace_shadow_account_class_hash(anonymizer: ContractAddress, new_class_hash: ClassHash) {
    run_eic_upgrade(
        :anonymizer,
        eic_name: "ShadowAccountClassHashEIC",
        eic_init_data: array![new_class_hash.into()].span(),
    );
}

fn deploy_eic() -> IEICInitializableDispatcher {
    let contract = declare("ShadowAccountClassHashEIC").unwrap_syscall().contract_class();
    let (contract_address, _) = contract.deploy(@array![]).unwrap_syscall();
    IEICInitializableDispatcher { contract_address }
}
