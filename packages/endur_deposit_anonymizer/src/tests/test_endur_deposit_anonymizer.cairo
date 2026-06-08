use core::num::traits::Zero;
use privacy::objects::OpenNoteDeposit;
use snforge_std::TokenTrait;
use starkware_utils_testing::test_utils::{TokenHelperTrait, assert_panic_with_felt_error};
use endur_deposit_anonymizer::endur_deposit_anonymizer::errors;
use endur_deposit_anonymizer::tests::test_utils::{
    EndurTrait, deploy_endur_components, deploy_mock_endur_vault_noop,
    deploy_mock_endur_vault_overflow,
};

const DEFAULT_AMOUNT: u128 = 1_000_000_000_000_000_000;

#[test]
#[test_case(Zero::zero())]
#[test_case(DEFAULT_AMOUNT)]
fn test_privacy_invoke_deposit(preexisting_balance: u128) {
    let endur = deploy_endur_components();
    let amount = DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    endur
        .underlying_token
        .supply(address: endur.deposit_anonymizer, amount: preexisting_balance + amount);

    assert_eq!(
        endur.underlying_token.balance_of(address: endur.deposit_anonymizer),
        (preexisting_balance + amount).into(),
    );
    assert_eq!(endur.vault_balance_of(address: endur.deposit_anonymizer), 0);

    let deposits = endur.privacy_invoke_deposit(:amount, :note_id);
    assert_eq!(deposits.len(), 1);
    let OpenNoteDeposit {
        note_id: ret_note_id, token: ret_out_token, amount: ret_out_amount,
    } = *deposits[0];

    assert_eq!(ret_note_id, note_id);
    assert_eq!(ret_out_token, endur.vault);
    assert_eq!(ret_out_amount, amount);
    assert_eq!(
        endur.underlying_token.balance_of(address: endur.deposit_anonymizer),
        preexisting_balance.into(),
    );
    assert_eq!(endur.underlying_token.balance_of(address: endur.vault), amount.into());
    assert_eq!(endur.vault_balance_of(address: endur.deposit_anonymizer), amount.into());
    assert_eq!(endur.vault_balance_of(address: endur.vault), 0);
}

#[test]
fn test_privacy_invoke_deposit_insufficient_balance() {
    let endur = deploy_endur_components();
    let amount = DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    let result = endur.safe_privacy_invoke_deposit(:amount, :note_id);
    assert_panic_with_felt_error(:result, expected_error: 'ERC20: insufficient balance');
}

#[test]
fn test_privacy_invoke_assertions() {
    let endur = deploy_endur_components();
    let amount = DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';
    let in_token = endur.underlying_token.contract_address();
    let out_token = endur.vault;

    let result = endur
        .safe_privacy_invoke(
            in_token: Zero::zero(), :out_token, assets: amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_TOKEN);

    let result = endur
        .safe_privacy_invoke(
            :in_token, out_token: Zero::zero(), assets: amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_TOKEN);

    let result = endur
        .safe_privacy_invoke(
            :in_token, :out_token, assets: Zero::zero(), :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ASSETS);

    let result = endur
        .safe_privacy_invoke(
            :in_token, out_token: in_token, assets: amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::TOKENS_EQUAL);
}

#[test]
fn test_privacy_invoke_zero_out_amount() {
    let mut endur = deploy_endur_components();
    let amount = DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    let vault = deploy_mock_endur_vault_noop(
        underlying_token: endur.underlying_token.contract_address(),
    );
    endur.vault = vault;

    let result = endur.safe_privacy_invoke_deposit(:amount, :note_id);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_AMOUNT);
}

#[test]
fn test_privacy_invoke_overflow() {
    let mut endur = deploy_endur_components();
    let amount = DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    let vault = deploy_mock_endur_vault_overflow(
        underlying_token: endur.underlying_token.contract_address(),
    );
    endur.vault = vault;

    let result = endur.safe_privacy_invoke_deposit(:amount, :note_id);
    assert_panic_with_felt_error(:result, expected_error: errors::RECEIVED_AMOUNT_OVERFLOW);
}
