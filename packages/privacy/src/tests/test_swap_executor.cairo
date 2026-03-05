use core::num::traits::Zero;
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::mock_swap_executor::errors;
use privacy::tests::utils_for_tests::{
    SwapExecutorCfg, SwapExecutorCfgTrait, Test, TestTrait, UserTrait, constants,
    deploy_mock_swap_executor,
};
use snforge_std::TokenTrait;
use starkware_utils::constants::MAX_U128;
use starkware_utils_testing::test_utils::{TokenHelperTrait, assert_panic_with_felt_error};

#[test]
#[test_case(Zero::zero())]
#[test_case(constants::DEFAULT_AMOUNT)]
fn test_privacy_invoke_basic(preexisting_balance: u128) {
    // Setup test environment.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();

    // Set up users with viewing keys and channel.
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2,
            token_addr: output_token.contract_address(),
            outgoing_channel_index: 0,
        );

    // Create an open note with swap_executor as depositor.
    let create_note_input = user_1
        .new_open_note_with_generated_random(
            recipient: user_2,
            token_addr: output_token.contract_address(),
            index: 0,
            depositor: test.privacy.swap_executor.address,
        );
    user_1.cheat_create_open_note_in_storage(:create_note_input);
    let (note_id, _) = user_1.compute_open_note(:create_note_input);

    // Fund swap executor with input tokens.
    input_token
        .supply(
            address: test.privacy.swap_executor.address, amount: preexisting_balance + swap_amount,
        );

    // Fund AMM with output tokens.
    output_token.supply(address: test.privacy.mock_amm, amount: swap_amount);

    // Verify balances before swap.
    assert_eq!(
        input_token.balance_of(address: test.privacy.swap_executor.address),
        (preexisting_balance + swap_amount).into(),
    );
    assert_eq!(input_token.balance_of(address: test.privacy.mock_amm), 0);
    assert_eq!(input_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.swap_executor.address), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.mock_amm), swap_amount.into());
    assert_eq!(output_token.balance_of(address: test.privacy.address), 0);

    // Execute swap.
    test
        .privacy
        .swap_executor
        .privacy_invoke(
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
            :note_id,
        );

    // Verify balances after swap.
    assert_eq!(
        input_token.balance_of(address: test.privacy.swap_executor.address),
        preexisting_balance.into(),
    );
    assert_eq!(input_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(input_token.balance_of(address: test.privacy.mock_amm), swap_amount.into());
    // Output tokens should now be in the swap executor (with allowance to the privacy contract).
    assert_eq!(
        output_token.balance_of(address: test.privacy.swap_executor.address), swap_amount.into(),
    );
    assert_eq!(output_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.mock_amm), 0);
    let output_token_dispatcher = IERC20Dispatcher {
        contract_address: output_token.contract_address(),
    };
    assert_eq!(
        output_token_dispatcher
            .allowance(owner: test.privacy.swap_executor.address, spender: test.privacy.address),
        swap_amount.into(),
    );
}

#[test]
fn test_privacy_invoke_propagates_amm_error() {
    // Test that errors from the AMM contract are properly propagated.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    // Verify balances before swap (swap executor intentionally not funded).
    assert_eq!(input_token.balance_of(address: test.privacy.swap_executor.address), 0);
    assert_eq!(input_token.balance_of(address: test.privacy.mock_amm), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.swap_executor.address), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.mock_amm), 0);

    // Fund swap executor with input tokens.
    input_token.supply(address: test.privacy.swap_executor.address, amount: swap_amount);

    // Don't fund AMM - transfer will fail due to insufficient balance.
    let result = test
        .privacy
        .swap_executor
        .safe_privacy_invoke(
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
            :note_id,
        );

    // Verify that the AMM error propagated (swap executor didn't swallow it).
    assert_panic_with_felt_error(:result, expected_error: 'ERC20: insufficient balance');
}

#[test]
fn test_privacy_invoke_panics_on_zero_out_amount() {
    // Test that when swap returns 0 tokens, the function panics.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    let swap_executor = deploy_mock_swap_executor(
        amm_address: test.privacy.mock_amm, selector: selector!("noop_swap"),
    );

    // Fund swap executor with input tokens.
    input_token.supply(address: swap_executor, amount: swap_amount);

    // Verify balances before swap.
    assert_eq!(input_token.balance_of(address: swap_executor), swap_amount.into());
    assert_eq!(input_token.balance_of(address: test.privacy.mock_amm), 0);
    assert_eq!(output_token.balance_of(address: swap_executor), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.mock_amm), 0);

    // Call noop_swap which does nothing (returns 0 tokens) - should panic.
    let swap_executor_cfg = SwapExecutorCfg {
        address: swap_executor, privacy_address: test.privacy.address,
    };
    let result = swap_executor_cfg
        .safe_privacy_invoke(
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
            :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_AMOUNT);
}

#[test]
fn test_privacy_invoke_received_amount_overflow() {
    // Test that error is raised when swap returns an amount exceeding u128::MAX.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    let swap_executor = deploy_mock_swap_executor(
        amm_address: test.privacy.mock_amm, selector: selector!("overflow_swap"),
    );
    // Fund swap executor with input tokens.
    input_token.supply(address: swap_executor, amount: swap_amount);

    // Fund AMM with output tokens exceeding u128::MAX.
    // Note: supply takes u128, so we supply MAX_U128 first, then 1 more.
    output_token.supply(address: test.privacy.mock_amm, amount: MAX_U128);
    output_token.supply(address: test.privacy.mock_amm, amount: 1);

    // Verify balances before swap.
    assert_eq!(input_token.balance_of(address: swap_executor), swap_amount.into());
    assert_eq!(input_token.balance_of(address: test.privacy.mock_amm), 0);
    assert_eq!(output_token.balance_of(address: swap_executor), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.mock_amm), MAX_U128.into() + 1);

    // Call overflow_swap which returns an amount exceeding u128::MAX.
    let swap_executor_cfg = SwapExecutorCfg {
        address: swap_executor, privacy_address: test.privacy.address,
    };
    let result = swap_executor_cfg
        .safe_privacy_invoke(
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
            :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::RECEIVED_AMOUNT_OVERFLOW);
}

#[test]
fn test_privacy_invoke_insufficient_balance() {
    // Test that swap fails when the swap executor has insufficient balance.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    let result = test
        .privacy
        .swap_executor
        .safe_privacy_invoke(
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
            :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INSUFFICIENT_BALANCE);
}
