use core::num::traits::Zero;
use privacy::objects::OpenNoteDeposit;
use snforge_std::TokenTrait;
use starkware_utils::constants::MAX_U128;
use starkware_utils_testing::test_utils::{TokenHelperTrait, assert_panic_with_felt_error};
use vesu_lending_helper::tests::test_utils::{
    VesuTrait, deploy_mock_vesu_vault_noop, deploy_mock_vesu_vault_overflow, deploy_vesu_components,
};
use vesu_lending_helper::vesu_lending_helper::{LendingOperation, errors};

const DEFAULT_AMOUNT: u128 = 1_000_000_000_000_000_000;

#[test]
#[test_case(Zero::zero())]
#[test_case(DEFAULT_AMOUNT)]
fn test_privacy_invoke_deposit_withdraw(preexisting_balance: u128) {
    let vesu = deploy_vesu_components();
    let amount = DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    vesu
        .underlying_token
        .supply(address: vesu.lending_helper, amount: preexisting_balance + amount);

    assert_eq!(
        vesu.underlying_token.balance_of(address: vesu.lending_helper),
        (preexisting_balance + amount).into(),
    );
    assert_eq!(vesu.vault_balance_of(address: vesu.lending_helper), 0);

    let deposits = vesu.privacy_invoke_deposit(:amount, :note_id);
    assert_eq!(deposits.len(), 1);
    let OpenNoteDeposit {
        note_id: ret_note_id, token: ret_out_token, amount: ret_out_amount,
    } = *deposits[0];

    assert_eq!(ret_note_id, note_id);
    assert_eq!(ret_out_token, vesu.vault);
    assert_eq!(ret_out_amount, amount);
    assert_eq!(
        vesu.underlying_token.balance_of(address: vesu.lending_helper), preexisting_balance.into(),
    );
    assert_eq!(vesu.underlying_token.balance_of(address: vesu.vault), amount.into());
    assert_eq!(vesu.vault_balance_of(address: vesu.lending_helper), amount.into());
    assert_eq!(vesu.vault_balance_of(address: vesu.vault), 0);

    let deposits = vesu.privacy_invoke_withdraw(:amount, :note_id);
    assert_eq!(deposits.len(), 1);
    let OpenNoteDeposit {
        note_id: ret_note_id, token: ret_out_token, amount: ret_out_amount,
    } = *deposits[0];

    assert_eq!(ret_note_id, note_id);
    assert_eq!(ret_out_token, vesu.underlying_token.contract_address());
    assert_eq!(ret_out_amount, amount);
    assert_eq!(vesu.vault_balance_of(address: vesu.lending_helper), 0);
    assert_eq!(vesu.vault_balance_of(address: vesu.vault), 0);
    assert_eq!(
        vesu.underlying_token.balance_of(address: vesu.lending_helper),
        (preexisting_balance + amount).into(),
    );
    assert_eq!(vesu.underlying_token.balance_of(address: vesu.vault), 0);
}

#[test]
fn test_privacy_invoke_deposit_insufficient_balance() {
    let vesu = deploy_vesu_components();
    let amount = DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    // Do not fund helper.

    let result = vesu.safe_privacy_invoke_deposit(:amount, :note_id);
    assert_panic_with_felt_error(:result, expected_error: 'ERC20: insufficient balance');

    let result = vesu.safe_privacy_invoke_withdraw(:amount, :note_id);
    assert_panic_with_felt_error(:result, expected_error: 'ERC20: insufficient balance');
}

#[test]
fn test_privacy_invoke_assertions() {
    let vesu = deploy_vesu_components();
    let amount = DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';
    let deposit = LendingOperation::Deposit;
    let withdraw = LendingOperation::Withdraw;
    let in_token = vesu.underlying_token.contract_address();
    let out_token = vesu.vault;

    // Catch ZERO_IN_TOKEN.
    let result = vesu
        .safe_privacy_invoke(
            operation: deposit, in_token: Zero::zero(), :out_token, assets: amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_TOKEN);
    let result = vesu
        .safe_privacy_invoke(
            operation: withdraw, in_token: Zero::zero(), :out_token, assets: amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_TOKEN);

    // Catch ZERO_OUT_TOKEN.
    let result = vesu
        .safe_privacy_invoke(
            operation: deposit, :in_token, out_token: Zero::zero(), assets: amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_TOKEN);
    let result = vesu
        .safe_privacy_invoke(
            operation: withdraw, :in_token, out_token: Zero::zero(), assets: amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_TOKEN);

    // Catch ZERO_ ASSETS.
    let result = vesu
        .safe_privacy_invoke(
            operation: deposit, :in_token, :out_token, assets: Zero::zero(), :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ASSETS);
    let result = vesu
        .safe_privacy_invoke(
            operation: withdraw, :in_token, :out_token, assets: Zero::zero(), :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ASSETS);

    // Catch TOKENS_EQUAL.
    let result = vesu
        .safe_privacy_invoke(
            operation: deposit, :in_token, out_token: in_token, assets: amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::TOKENS_EQUAL);
    let result = vesu
        .safe_privacy_invoke(
            operation: withdraw, :in_token, out_token: in_token, assets: amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::TOKENS_EQUAL);
}

#[test]
fn test_privacy_invoke_zero_out_amount() {
    let mut vesu = deploy_vesu_components();
    let amount = DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    let vault = deploy_mock_vesu_vault_noop(
        underlying_token: vesu.underlying_token.contract_address(),
    );
    vesu.vault = vault;

    let result = vesu.safe_privacy_invoke_deposit(:amount, :note_id);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_AMOUNT);
    let result = vesu.safe_privacy_invoke_withdraw(:amount, :note_id);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_AMOUNT);
}

#[test]
fn test_privacy_invoke_overflow() {
    let mut vesu = deploy_vesu_components();
    let amount = DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    let vault = deploy_mock_vesu_vault_overflow(
        underlying_token: vesu.underlying_token.contract_address(),
    );
    vesu.vault = vault;

    // Fund vault with amount exceeding u128::MAX.
    vesu.underlying_token.supply(address: vesu.vault, amount: MAX_U128);
    vesu.underlying_token.supply(address: vesu.vault, amount: 1);

    let result = vesu.safe_privacy_invoke_deposit(:amount, :note_id);
    assert_panic_with_felt_error(:result, expected_error: errors::RECEIVED_AMOUNT_OVERFLOW);

    let result = vesu.safe_privacy_invoke_withdraw(:amount, :note_id);
    assert_panic_with_felt_error(:result, expected_error: errors::RECEIVED_AMOUNT_OVERFLOW);
}
