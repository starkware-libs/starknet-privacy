use core::hash::HashStateTrait;
use core::num::traits::{Bounded, Zero};
use core::poseidon::PoseidonTrait;
use openzeppelin::interfaces::ownable::{
    IOwnableDispatcher, IOwnableDispatcherTrait, IOwnableSafeDispatcher,
    IOwnableSafeDispatcherTrait,
};
use openzeppelin::interfaces::upgrades::{
    IUpgradeableSafeDispatcher, IUpgradeableSafeDispatcherTrait,
};
use privacy::objects::OpenNoteDeposit;
use snforge_std::{DeclareResultTrait, TokenTrait, declare};
use starknet::account::Call;
use starknet::{ContractAddress, SyscallResultTrait};
use starkware_utils::contracts::sub_account::{ISubAccountDispatcher, ISubAccountDispatcherTrait};
use starkware_utils_testing::test_utils::{
    TokenHelperTrait, assert_panic_with_felt_error, cheat_caller_address_once,
};
use sub_account_anonymizer::sub_account_anonymizer::{
    ISubAccountAnonymizerDispatcherTrait, ISubAccountAnonymizerSafeDispatcher,
    ISubAccountAnonymizerSafeDispatcherTrait, errors,
};
use sub_account_anonymizer::tests::test_utils::{
    ComponentsTrait, OWNER, PRIVACY, anonymizer_disp, deploy_components,
    deploy_sub_account_anonymizer, deploy_token, pay_out_call,
};

const AMOUNT: u128 = 1_000_000;
const NOTE_ID: felt252 = 'NOTE_ID';
/// Error raised by `OwnableComponent::assert_only_owner` for an unauthorized caller.
const NOT_OWNER: felt252 = 'Caller is not the owner';

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
fn test_privacy_compute_matches_poseidon() {
    let anonymizer = deploy_sub_account_anonymizer();
    let commitment = anonymizer_disp(anonymizer).privacy_compute('USER', 'DAPP', 7);
    let expected = PoseidonTrait::new().update('USER').update('DAPP').update(7).finalize();
    assert_eq!(commitment, expected);
}

#[test]
fn test_privacy_compute_is_deterministic_and_distinct() {
    let anonymizer = anonymizer_disp(deploy_sub_account_anonymizer());
    let base = anonymizer.privacy_compute('USER', 'DAPP', 1);
    // Deterministic for the same inputs.
    assert_eq!(base, anonymizer.privacy_compute('USER', 'DAPP', 1));
    // Each input affects the commitment.
    assert_ne!(base, anonymizer.privacy_compute('OTHER', 'DAPP', 1));
    assert_ne!(base, anonymizer.privacy_compute('USER', 'OTHER', 1));
    assert_ne!(base, anonymizer.privacy_compute('USER', 'DAPP', 2));
}

#[test]
fn test_invoke_executes_and_collects_open_note() {
    let components = deploy_components();
    let token = components.token.contract_address();
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
    assert_eq!(components.token.balance_of(components.mock_dapp), 0);
    assert_eq!(components.token.balance_of(sub_account), 0);
    assert_eq!(components.token.balance_of(components.anonymizer), AMOUNT.into());
    assert_eq!(components.token.allowance(components.anonymizer, PRIVACY), AMOUNT.into());
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

#[test]
fn test_collects_multiple_open_notes() {
    let components = deploy_components();
    let token_a = components.token;
    let token_b = deploy_token();
    let addr_a = token_a.contract_address();
    let addr_b = token_b.contract_address();
    assert!(addr_a != addr_b);
    let commitment = anonymizer_disp(components.anonymizer).privacy_compute('USER', 'DAPP', 1);

    let amount_a: u128 = 1_000_000;
    let amount_b: u128 = 2_500_000;
    token_a.supply(address: components.mock_dapp, amount: amount_a);
    token_b.supply(address: components.mock_dapp, amount: amount_b);

    let deposits = components
        .invoke(
            :commitment,
            invokes: array![
                pay_out_call(components.mock_dapp, addr_a, amount_a),
                pay_out_call(components.mock_dapp, addr_b, amount_b),
            ],
            open_notes: array![('NOTE_A', addr_a), ('NOTE_B', addr_b)].span(),
        );

    // One deposit per note, each carrying its own token/amount.
    assert_eq!(deposits.len(), 2);
    let OpenNoteDeposit { note_id: id_a, token: tok_a, amount: amt_a } = *deposits[0];
    assert_eq!(id_a, 'NOTE_A');
    assert_eq!(tok_a, addr_a);
    assert_eq!(amt_a, amount_a);
    let OpenNoteDeposit { note_id: id_b, token: tok_b, amount: amt_b } = *deposits[1];
    assert_eq!(id_b, 'NOTE_B');
    assert_eq!(tok_b, addr_b);
    assert_eq!(amt_b, amount_b);

    assert_eq!(token_a.balance_of(components.mock_dapp), 0);
    assert_eq!(token_b.balance_of(components.mock_dapp), 0);
    assert_eq!(token_a.balance_of(components.anonymizer), amount_a.into());
    assert_eq!(token_b.balance_of(components.anonymizer), amount_b.into());
    assert_eq!(token_a.allowance(components.anonymizer, PRIVACY), amount_a.into());
    assert_eq!(token_b.allowance(components.anonymizer, PRIVACY), amount_b.into());
}

#[test]
fn test_multiple_invokes_run_in_one_call() {
    let components = deploy_components();
    let token = components.token.contract_address();
    let commitment = anonymizer_disp(components.anonymizer).privacy_compute('USER', 'DAPP', 1);

    let first: u128 = 700_000;
    let second: u128 = 300_000;
    components.token.supply(address: components.mock_dapp, amount: first + second);

    // Two calls in one interaction; both run as the sub-account and their output is combined.
    let deposits = components
        .invoke(
            :commitment,
            invokes: array![
                pay_out_call(components.mock_dapp, token, first),
                pay_out_call(components.mock_dapp, token, second),
            ],
            open_notes: array![(NOTE_ID, token)].span(),
        );

    let OpenNoteDeposit { note_id, token: deposit_token, amount } = *deposits[0];
    assert_eq!(note_id, NOTE_ID);
    assert_eq!(deposit_token, token);
    assert_eq!(amount, first + second);
    assert_eq!(components.token.balance_of(components.anonymizer), (first + second).into());
}

#[test]
fn test_invoke_but_not_collect() {
    let components = deploy_components();
    let token = components.token.contract_address();
    let commitment = anonymizer_disp(components.anonymizer).privacy_compute('USER', 'DAPP', 1);

    let first: u128 = 1_000_000;
    let second: u128 = 400_000;
    components.token.supply(address: components.mock_dapp, amount: first + second);

    let deposits = components
        .invoke(
            :commitment,
            invokes: array![pay_out_call(components.mock_dapp, token, first)],
            open_notes: array![].span(),
        );
    assert_eq!(deposits.len(), 0);
    assert_eq!(components.token.balance_of(components.anonymizer), 0);
    let sub_account = anonymizer_disp(components.anonymizer).get_sub_account(commitment);
    assert_eq!(components.token.balance_of(sub_account), first.into());
}

#[test]
fn test_deployed_sub_account_owned_by_anonymizer() {
    let components = deploy_components();
    let commitment = anonymizer_disp(components.anonymizer).privacy_compute('USER', 'DAPP', 1);
    components.invoke(:commitment, invokes: array![], open_notes: array![].span());

    let sub_account = anonymizer_disp(components.anonymizer).get_sub_account(commitment);
    // The anonymizer is the sub-account's deployer, so it is the only authorized controller.
    assert_eq!(
        ISubAccountDispatcher { contract_address: sub_account }.owner(), components.anonymizer,
    );
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
fn test_collects_only_funds_added_by_invoke() {
    let components = deploy_components();
    let token = components.token.contract_address();
    let commitment = anonymizer_disp(components.anonymizer).privacy_compute('USER', 'DAPP', 1);

    // Deploy the sub-account (empty invoke) so we can give it a pre-existing balance.
    components.invoke(:commitment, invokes: array![], open_notes: array![].span());
    let sub_account = anonymizer_disp(components.anonymizer).get_sub_account(commitment);
    let preexisting: u128 = 500_000;
    components.token.supply(address: sub_account, amount: preexisting);

    // The interaction adds `AMOUNT` on top of the pre-existing balance.
    components.token.supply(address: components.mock_dapp, amount: AMOUNT);
    let deposits = components
        .invoke(
            :commitment,
            invokes: array![pay_out_call(components.mock_dapp, token, AMOUNT)],
            open_notes: array![(NOTE_ID, token)].span(),
        );

    // Only the added `AMOUNT` is collected; the pre-existing balance stays in the sub-account.
    assert_eq!(deposits.len(), 1);
    let OpenNoteDeposit { note_id, token: deposit_token, amount } = *deposits[0];
    assert_eq!(note_id, NOTE_ID);
    assert_eq!(deposit_token, token);
    assert_eq!(amount, AMOUNT);
    assert_eq!(components.token.balance_of(components.mock_dapp), 0);
    assert_eq!(components.token.balance_of(sub_account), preexisting.into());
    assert_eq!(components.token.balance_of(components.anonymizer), AMOUNT.into());
    assert_eq!(components.token.allowance(components.anonymizer, PRIVACY), AMOUNT.into());
}

#[test]
fn test_zero_delta_open_note_collects_nothing() {
    let components = deploy_components();
    let token = components.token.contract_address();
    let commitment = anonymizer_disp(components.anonymizer).privacy_compute('USER', 'DAPP', 1);

    // No invokes, so the open-note token's balance is unchanged → zero delta.
    let deposits = components
        .invoke(:commitment, invokes: array![], open_notes: array![(NOTE_ID, token)].span());

    assert_eq!(deposits.len(), 1);
    let OpenNoteDeposit { note_id, token: deposit_token, amount } = *deposits[0];
    assert_eq!(note_id, NOTE_ID);
    assert_eq!(deposit_token, token);
    assert_eq!(amount, 0);
    assert_eq!(components.token.balance_of(components.anonymizer), 0);
}

#[test]
fn test_decreased_balance_collects_nothing() {
    let components = deploy_components();
    let token = components.token.contract_address();
    let commitment = anonymizer_disp(components.anonymizer).privacy_compute('USER', 'DAPP', 1);

    // Deploy and pre-fund the sub-account.
    components.invoke(:commitment, invokes: array![], open_notes: array![].span());
    let sub_account = anonymizer_disp(components.anonymizer).get_sub_account(commitment);
    let preexisting: u128 = 1_000_000;
    components.token.supply(address: sub_account, amount: preexisting);

    // The invoke makes the sub-account send tokens out, decreasing its balance.
    let sink: ContractAddress = 'SINK'.try_into().unwrap();
    let sent: u128 = 300_000;
    let transfer = Call {
        to: token,
        selector: selector!("transfer"),
        calldata: array![sink.into(), sent.into(), 0].span(),
    };
    let deposits = components
        .invoke(
            :commitment, invokes: array![transfer], open_notes: array![(NOTE_ID, token)].span(),
        );

    // Delta is negative, so it clamps to zero — nothing collected.
    let OpenNoteDeposit { note_id, token: deposit_token, amount } = *deposits[0];
    assert_eq!(note_id, NOTE_ID);
    assert_eq!(deposit_token, token);
    assert_eq!(amount, 0);
    assert_eq!(components.token.balance_of(sub_account), (preexisting - sent).into());
    assert_eq!(components.token.balance_of(components.anonymizer), 0);
    assert_eq!(components.token.balance_of(sink), sent.into());
}

#[test]
#[should_panic(expected: 'COLLECTED_AMOUNT_OVERFLOW')]
fn test_collected_amount_overflow() {
    let components = deploy_components();
    let token = components.token.contract_address();
    let commitment = anonymizer_disp(components.anonymizer).privacy_compute('USER', 'DAPP', 1);

    // Fund the dapp with `u128::MAX + 1` (two supplies, since `supply` takes a u128).
    let max = Bounded::<u128>::MAX;
    components.token.supply(address: components.mock_dapp, amount: max);
    components.token.supply(address: components.mock_dapp, amount: 1);

    // Two pay-outs add `u128::MAX + 1` to the sub-account, so the collected delta overflows u128.
    components
        .invoke(
            :commitment,
            invokes: array![
                pay_out_call(components.mock_dapp, token, max),
                pay_out_call(components.mock_dapp, token, 1),
            ],
            open_notes: array![(NOTE_ID, token)].span(),
        );
}

#[test]
fn test_owner_is_configured() {
    let anonymizer = deploy_sub_account_anonymizer();
    assert_eq!(IOwnableDispatcher { contract_address: anonymizer }.owner(), OWNER);
}

#[test]
#[feature("safe_dispatcher")]
fn test_upgrade_rejects_non_owner_and_allows_owner() {
    let anonymizer = deploy_sub_account_anonymizer();
    let new_class_hash = *declare("SubAccount").unwrap_syscall().contract_class().class_hash;
    let safe = IUpgradeableSafeDispatcher { contract_address: anonymizer };

    let result = safe.upgrade(new_class_hash);
    assert_panic_with_felt_error(:result, expected_error: NOT_OWNER);

    cheat_caller_address_once(contract_address: anonymizer, caller_address: OWNER);
    assert!(safe.upgrade(new_class_hash).is_ok());
}
