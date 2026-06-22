use core::num::traits::Zero;
use privacy::objects::OpenNoteDeposit;
use snforge_std::TokenTrait;
use starkware_utils::constants::MAX_U128;
use starkware_utils_testing::test_utils::{TokenHelperTrait, assert_panic_with_felt_error};
use vesu_lending_anonymizer::tests::test_utils::{
    VesuTrait, deploy_mock_vesu_vault_interest, deploy_mock_vesu_vault_noop,
    deploy_mock_vesu_vault_overflow, deploy_vesu_components,
};
use vesu_lending_anonymizer::vesu_lending_anonymizer::{LendingOperation, errors};

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
        .supply(address: vesu.lending_anonymizer, amount: preexisting_balance + amount);

    assert_eq!(
        vesu.underlying_token.balance_of(address: vesu.lending_anonymizer),
        (preexisting_balance + amount).into(),
    );
    assert_eq!(vesu.vault_balance_of(address: vesu.lending_anonymizer), 0);

    let deposits = vesu.privacy_invoke_deposit(:amount, :note_id);
    assert_eq!(deposits.len(), 1);
    let OpenNoteDeposit {
        note_id: ret_note_id, token: ret_out_token, amount: ret_out_amount,
    } = *deposits[0];

    assert_eq!(ret_note_id, note_id);
    assert_eq!(ret_out_token, vesu.vault);
    assert_eq!(ret_out_amount, amount);
    assert_eq!(
        vesu.underlying_token.balance_of(address: vesu.lending_anonymizer),
        preexisting_balance.into(),
    );
    assert_eq!(vesu.underlying_token.balance_of(address: vesu.vault), amount.into());
    assert_eq!(vesu.vault_balance_of(address: vesu.lending_anonymizer), amount.into());
    assert_eq!(vesu.vault_balance_of(address: vesu.vault), 0);

    let deposits = vesu.privacy_invoke_withdraw(:amount, :note_id);
    assert_eq!(deposits.len(), 1);
    let OpenNoteDeposit {
        note_id: ret_note_id, token: ret_out_token, amount: ret_out_amount,
    } = *deposits[0];

    assert_eq!(ret_note_id, note_id);
    assert_eq!(ret_out_token, vesu.underlying_token.contract_address());
    assert_eq!(ret_out_amount, amount);
    assert_eq!(vesu.vault_balance_of(address: vesu.lending_anonymizer), 0);
    assert_eq!(vesu.vault_balance_of(address: vesu.vault), 0);
    assert_eq!(
        vesu.underlying_token.balance_of(address: vesu.lending_anonymizer),
        (preexisting_balance + amount).into(),
    );
    assert_eq!(vesu.underlying_token.balance_of(address: vesu.vault), 0);
}

#[test]
fn test_privacy_invoke_deposit_insufficient_balance() {
    let vesu = deploy_vesu_components();
    let amount = DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    // Do not fund anonymizer.

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
            operation: deposit, in_token: Zero::zero(), :out_token, :amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_TOKEN);
    let result = vesu
        .safe_privacy_invoke(
            operation: withdraw, in_token: Zero::zero(), :out_token, :amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_TOKEN);

    // Catch ZERO_OUT_TOKEN.
    let result = vesu
        .safe_privacy_invoke(
            operation: deposit, :in_token, out_token: Zero::zero(), :amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_TOKEN);
    let result = vesu
        .safe_privacy_invoke(
            operation: withdraw, :in_token, out_token: Zero::zero(), :amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_TOKEN);

    // Catch ZERO_AMOUNT.
    let result = vesu
        .safe_privacy_invoke(
            operation: deposit, :in_token, :out_token, amount: Zero::zero(), :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);
    let result = vesu
        .safe_privacy_invoke(
            operation: withdraw, :in_token, :out_token, amount: Zero::zero(), :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);

    // Catch TOKENS_EQUAL.
    let result = vesu
        .safe_privacy_invoke(operation: deposit, :in_token, out_token: in_token, :amount, :note_id);
    assert_panic_with_felt_error(:result, expected_error: errors::TOKENS_EQUAL);
    let result = vesu
        .safe_privacy_invoke(
            operation: withdraw, :in_token, out_token: in_token, :amount, :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::TOKENS_EQUAL);
}

/// Withdraw must redeem the exact share count the pool holds, not an underlying amount; otherwise
/// shares are stranded in the stateless anonymizer.
#[test]
fn test_privacy_invoke_withdraw_redeems_exact_shares() {
    let mut vesu = deploy_vesu_components();
    let amount = DEFAULT_AMOUNT;

    // Swap in a vault whose shares redeem for 2x underlying (models accrued interest).
    let vault = deploy_mock_vesu_vault_interest(
        underlying_token: vesu.underlying_token.contract_address(),
    );
    vesu.vault = vault;

    // Deposit `amount` underlying → anonymizer receives `amount` shares (1:1 deposit).
    vesu.underlying_token.supply(address: vesu.lending_anonymizer, amount: amount);
    vesu.privacy_invoke_deposit(:amount, note_id: 'DEPOSIT_NOTE');
    assert_eq!(vesu.vault_balance_of(address: vesu.lending_anonymizer), amount.into());

    // Pre-fund the vault so it can pay out the 2x redemption.
    vesu.underlying_token.supply(address: vesu.vault, amount: amount);

    // Withdraw redeems the exact share count (`amount`), not an underlying amount.
    let deposits = vesu.privacy_invoke_withdraw(:amount, note_id: 'WITHDRAW_NOTE');
    let OpenNoteDeposit { note_id: _, token: ret_out_token, amount: ret_out_amount } = *deposits[0];

    // All shares burned: nothing stranded in the stateless anonymizer.
    assert_eq!(vesu.vault_balance_of(address: vesu.lending_anonymizer), 0);
    // Received the full 2x underlying value of the redeemed shares.
    assert_eq!(ret_out_token, vesu.underlying_token.contract_address());
    assert_eq!(ret_out_amount, amount * 2);
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
