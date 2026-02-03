use core::num::traits::{Bounded, Zero};
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{TokenTrait, set_balance};
use starkware_utils_testing::test_utils::{assert_panic_with_felt_error, cheat_caller_address_once};
use crate::swap_executor::errors;
use crate::swap_executor::tests::mock_amm::RATE_DENOMINATOR;
use crate::tests::utils_for_tests::{
    SwapExecutorCfgTrait, Test, TestTrait, constants, deploy_mock_amm_with_exchange_rate,
};

#[test]
fn test_swap_basic() {
    // Setup test environment.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Fund swap executor with input tokens.
    set_balance(
        target: test.swap_executor.address, new_balance: swap_amount.into(), token: input_token,
    );

    // Fund AMM with output tokens.
    set_balance(
        target: test.mock_amm.address, new_balance: swap_amount.into(), token: output_token,
    );

    // Cheat caller to be privacy contract.
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );

    // Prepare swap calldata: [input_token, output_token].
    let swap_calldata = array![
        input_token.contract_address().into(), output_token.contract_address().into(),
    ];

    // Execute swap.
    let received = test
        .swap_executor
        .swap(
            swap_contract: test.mock_amm.address,
            swap_selector: selector!("swap"),
            swap_calldata: swap_calldata.span(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
        );

    // Verify returned amount is correct (1:1 exchange rate).
    assert_eq!(received, swap_amount);

    // Verify swap executor holds the output tokens.
    let executor_balance = IERC20Dispatcher { contract_address: output_token.contract_address() }
        .balance_of(account: test.swap_executor.address);
    assert_eq!(executor_balance, swap_amount.into());

    // Verify privacy pool has approval to transfer the received tokens.
    let allowance = IERC20Dispatcher { contract_address: output_token.contract_address() }
        .allowance(owner: test.swap_executor.address, spender: test.swap_executor.privacy_address);
    assert_eq!(allowance, swap_amount.into());
}

#[test]
fn test_swap_different_exchange_rate() {
    // Setup test environment.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Deploy mock AMM with 50% exchange rate.
    let exchange_rate = RATE_DENOMINATOR / 2;
    let amm = deploy_mock_amm_with_exchange_rate(:exchange_rate);
    let expected_output: u128 = (swap_amount.into() * exchange_rate / RATE_DENOMINATOR)
        .try_into()
        .unwrap();

    // Fund swap executor with input tokens.
    set_balance(
        target: test.swap_executor.address, new_balance: swap_amount.into(), token: input_token,
    );

    // Fund AMM with output tokens (enough for the exchange).
    set_balance(target: amm.address, new_balance: (swap_amount * 2).into(), token: output_token);

    // Cheat caller to be privacy contract.
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );

    // Prepare swap calldata: [input_token, output_token].
    let swap_calldata = array![
        input_token.contract_address().into(), output_token.contract_address().into(),
    ];

    // Execute swap.
    let received = test
        .swap_executor
        .swap(
            swap_contract: amm.address,
            swap_selector: selector!("swap"),
            swap_calldata: swap_calldata.span(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
        );

    // Verify returned amount is correct (50% exchange rate).
    assert_eq!(received, expected_output);

    // Verify privacy pool has approval for the received amount.
    let allowance = IERC20Dispatcher { contract_address: output_token.contract_address() }
        .allowance(owner: test.swap_executor.address, spender: test.swap_executor.privacy_address);
    assert_eq!(allowance, expected_output.into());
}

#[test]
fn test_swap_assertions() {
    use starknet::ContractAddress;

    let test: Test = Default::default();
    let valid_swap_contract = test.mock_amm.address;
    let valid_selector = selector!("swap");
    let valid_calldata = array![0];
    let valid_in_token: ContractAddress = 'INPUT_TOKEN'.try_into().unwrap();
    let valid_out_token: ContractAddress = 'OUTPUT_TOKEN'.try_into().unwrap();
    let valid_amount = 100_u128;

    // INVALID_CALLER: Don't cheat caller.
    let result = test
        .swap_executor
        .safe_swap(
            swap_contract: valid_swap_contract,
            swap_selector: valid_selector,
            swap_calldata: valid_calldata.span(),
            in_token: valid_in_token,
            out_token: valid_out_token,
            in_amount: valid_amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CALLER);

    // ZERO_SWAP_CONTRACT
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );
    let result = test
        .swap_executor
        .safe_swap(
            swap_contract: Zero::zero(),
            swap_selector: valid_selector,
            swap_calldata: valid_calldata.span(),
            in_token: valid_in_token,
            out_token: valid_out_token,
            in_amount: valid_amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SWAP_CONTRACT);

    // ZERO_SWAP_SELECTOR
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );
    let result = test
        .swap_executor
        .safe_swap(
            swap_contract: valid_swap_contract,
            swap_selector: Zero::zero(),
            swap_calldata: valid_calldata.span(),
            in_token: valid_in_token,
            out_token: valid_out_token,
            in_amount: valid_amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SWAP_SELECTOR);

    // ZERO_IN_TOKEN
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );
    let result = test
        .swap_executor
        .safe_swap(
            swap_contract: valid_swap_contract,
            swap_selector: valid_selector,
            swap_calldata: valid_calldata.span(),
            in_token: Zero::zero(),
            out_token: valid_out_token,
            in_amount: valid_amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_TOKEN);

    // ZERO_OUT_TOKEN
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );
    let result = test
        .swap_executor
        .safe_swap(
            swap_contract: valid_swap_contract,
            swap_selector: valid_selector,
            swap_calldata: valid_calldata.span(),
            in_token: valid_in_token,
            out_token: Zero::zero(),
            in_amount: valid_amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_TOKEN);

    // ZERO_AMOUNT
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );
    let result = test
        .swap_executor
        .safe_swap(
            swap_contract: valid_swap_contract,
            swap_selector: valid_selector,
            swap_calldata: valid_calldata.span(),
            in_token: valid_in_token,
            out_token: valid_out_token,
            in_amount: 0,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);
}

#[test]
fn test_swap_propagates_amm_error() {
    // Test that errors from the AMM contract are properly propagated.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();

    // Fund swap executor so the approve call succeeds before the failing swap.
    set_balance(
        target: test.swap_executor.address,
        new_balance: constants::DEFAULT_AMOUNT.into(),
        token: input_token,
    );

    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );

    // Call failing_swap which always panics with 'SWAP_FAILED'.
    let result = test
        .swap_executor
        .safe_swap(
            swap_contract: test.mock_amm.address,
            swap_selector: selector!("failing_swap"),
            swap_calldata: [0].span(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: constants::DEFAULT_AMOUNT,
        );
    assert_panic_with_felt_error(:result, expected_error: 'SWAP_FAILED');
}

#[test]
fn test_swap_zero_received_no_approval() {
    // Test that when swap returns 0 tokens, no approval is set.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Fund swap executor with input tokens.
    set_balance(
        target: test.swap_executor.address, new_balance: swap_amount.into(), token: input_token,
    );

    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );

    // Call noop_swap which does nothing (returns 0 tokens).
    let received = test
        .swap_executor
        .swap(
            swap_contract: test.mock_amm.address,
            swap_selector: selector!("noop_swap"),
            swap_calldata: [0].span(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
        );

    // Verify 0 was returned.
    assert_eq!(received, 0);

    // Verify no approval was set.
    let allowance = IERC20Dispatcher { contract_address: output_token.contract_address() }
        .allowance(owner: test.swap_executor.address, spender: test.swap_executor.privacy_address);
    assert_eq!(allowance, 0);
}

#[test]
fn test_swap_with_preexisting_balance() {
    // Test that only the received amount (balance diff) is returned and approved.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let preexisting_balance: u256 = 500;

    // Fund swap executor with input tokens AND some pre-existing output tokens.
    set_balance(
        target: test.swap_executor.address, new_balance: swap_amount.into(), token: input_token,
    );
    set_balance(
        target: test.swap_executor.address, new_balance: preexisting_balance, token: output_token,
    );

    // Fund AMM with output tokens.
    set_balance(
        target: test.mock_amm.address, new_balance: swap_amount.into(), token: output_token,
    );

    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );

    let swap_calldata = array![
        input_token.contract_address().into(), output_token.contract_address().into(),
    ];

    let received = test
        .swap_executor
        .swap(
            swap_contract: test.mock_amm.address,
            swap_selector: selector!("swap"),
            swap_calldata: swap_calldata.span(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
        );

    // Verify only the swap amount was returned (not preexisting + swap).
    assert_eq!(received, swap_amount);

    // Verify approval is only for the received amount.
    let allowance = IERC20Dispatcher { contract_address: output_token.contract_address() }
        .allowance(owner: test.swap_executor.address, spender: test.swap_executor.privacy_address);
    assert_eq!(allowance, swap_amount.into());

    // Verify swap executor has preexisting + swap amount.
    let executor_balance = IERC20Dispatcher { contract_address: output_token.contract_address() }
        .balance_of(account: test.swap_executor.address);
    assert_eq!(executor_balance, preexisting_balance + swap_amount.into());
}

#[test]
fn test_swap_received_amount_overflow() {
    // Test that error is raised when swap returns an amount exceeding u128::MAX.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Fund swap executor with input tokens.
    set_balance(
        target: test.swap_executor.address, new_balance: swap_amount.into(), token: input_token,
    );

    // Fund AMM with output tokens exceeding u128::MAX.
    set_balance(
        target: test.mock_amm.address,
        new_balance: Bounded::<u128>::MAX.into() + 1,
        token: output_token,
    );

    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );

    // Call overflow_swap which returns an amount exceeding u128::MAX.
    let swap_calldata = array![output_token.contract_address().into()];
    let result = test
        .swap_executor
        .safe_swap(
            swap_contract: test.mock_amm.address,
            swap_selector: selector!("overflow_swap"),
            swap_calldata: swap_calldata.span(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::RECEIVED_AMOUNT_OVERFLOW);
}

#[test]
fn test_get_privacy_pool() {
    let test: Test = Default::default();
    assert_eq!(test.swap_executor.get_privacy_pool(), test.privacy.address);
}
