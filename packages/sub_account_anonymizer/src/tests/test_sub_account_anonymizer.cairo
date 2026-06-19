use core::hash::HashStateTrait;
use core::num::traits::Zero;
use core::poseidon::PoseidonTrait;
use privacy::objects::OpenNoteDeposit;
use snforge_std::{DeclareResultTrait, declare};
use starknet::SyscallResultTrait;
use starkware_utils_testing::test_utils::{TokenHelperTrait, assert_panic_with_felt_error};
use sub_account_anonymizer::sub_account_anonymizer::{
    ISubAccountAnonymizerDispatcherTrait, ISubAccountAnonymizerSafeDispatcher,
    ISubAccountAnonymizerSafeDispatcherTrait, errors,
};
use sub_account_anonymizer::tests::test_utils::{
    ComponentsTrait, PRIVACY, anonymizer_disp, deploy_components, deploy_sub_account_anonymizer,
    pay_out_call,
};

const AMOUNT: u128 = 1_000_000;
const NOTE_ID: felt252 = 'NOTE_ID';

#[test]
fn test_privacy_compute_matches_poseidon() {
    let anonymizer = deploy_sub_account_anonymizer();
    let commitment = anonymizer_disp(anonymizer).privacy_compute('USER', 'DAPP', 7);
    let expected = PoseidonTrait::new().update('USER').update('DAPP').update(7).finalize();
    assert_eq!(commitment, expected);
}

#[test]
fn test_get_privacy_contract() {
    let anonymizer = deploy_sub_account_anonymizer();
    assert_eq!(anonymizer_disp(anonymizer).get_privacy_contract(), PRIVACY);
}

#[test]
fn test_get_sub_account_class_hash() {
    let anonymizer = deploy_sub_account_anonymizer();
    let expected = *declare("SubAccount").unwrap_syscall().contract_class().class_hash;
    assert_eq!(anonymizer_disp(anonymizer).get_sub_account_class_hash(), expected);
}

#[test]
fn test_get_sub_account_unknown_commitment_is_zero() {
    let anonymizer = deploy_sub_account_anonymizer();
    assert!(anonymizer_disp(anonymizer).get_sub_account('UNKNOWN').is_zero());
}

#[test]
fn test_invoke_executes_and_collects_open_note() {
    let components = deploy_components();
    let token = components.token_address();
    let commitment = anonymizer_disp(components.anonymizer).privacy_compute('USER', 'DAPP', 1);

    // Fund the dapp so the sub-account-driven call pays the sub-account `AMOUNT`.
    components.token.supply(address: components.mock_dapp, amount: AMOUNT);

    let deposits = components
        .invoke(
            :commitment,
            invokes: array![pay_out_call(components.mock_dapp, token, AMOUNT)],
            open_notes: array![(NOTE_ID, token)].span(),
        );

    // One deposit returned, matching the collected token/amount.
    assert_eq!(deposits.len(), 1);
    let OpenNoteDeposit { note_id, token: deposit_token, amount } = *deposits[0];
    assert_eq!(note_id, NOTE_ID);
    assert_eq!(deposit_token, token);
    assert_eq!(amount, AMOUNT);

    let sub_account = anonymizer_disp(components.anonymizer).get_sub_account(commitment);
    assert!(sub_account.is_non_zero());
    // Funds flowed dapp -> sub-account -> anonymizer, and the privacy contract is approved to pull.
    assert_eq!(components.balance_of(components.mock_dapp), 0);
    assert_eq!(components.balance_of(sub_account), 0);
    assert_eq!(components.balance_of(components.anonymizer), AMOUNT.into());
    assert_eq!(components.allowance(components.anonymizer, PRIVACY), AMOUNT.into());
}

#[test]
fn test_sub_account_is_reused_per_commitment() {
    let components = deploy_components();
    let anonymizer = anonymizer_disp(components.anonymizer);
    let commitment_a = anonymizer.privacy_compute('USER', 'DAPP', 1);
    let commitment_b = anonymizer.privacy_compute('USER', 'DAPP', 2);
    let no_notes = array![].span();

    components.invoke(commitment: commitment_a, invokes: array![], open_notes: no_notes);
    let sub_account_a = anonymizer.get_sub_account(commitment_a);
    assert!(sub_account_a.is_non_zero());

    // Same commitment reuses the same sub-account (no redeploy).
    components.invoke(commitment: commitment_a, invokes: array![], open_notes: no_notes);
    assert_eq!(anonymizer.get_sub_account(commitment_a), sub_account_a);

    // A different commitment gets a distinct sub-account.
    components.invoke(commitment: commitment_b, invokes: array![], open_notes: no_notes);
    let sub_account_b = anonymizer.get_sub_account(commitment_b);
    assert!(sub_account_b.is_non_zero());
    assert!(sub_account_b != sub_account_a);
}

#[test]
#[feature("safe_dispatcher")]
fn test_invoke_only_privacy_contract() {
    let components = deploy_components();
    // No caller cheat: the caller is the test contract, not the privacy contract.
    let safe = ISubAccountAnonymizerSafeDispatcher { contract_address: components.anonymizer };
    let result = safe
        .privacy_invoke_with_computation(
            commitment: 0, invokes: array![], open_notes: array![].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::CALLER_NOT_PRIVACY);
}
