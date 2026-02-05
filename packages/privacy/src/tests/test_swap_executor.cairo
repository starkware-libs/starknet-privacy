use core::num::traits::Zero;
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::swap_executor::errors;
use privacy::tests::utils_for_tests::{SwapExecutorCfgTrait, Test, TestTrait, constants};
use snforge_std::{TokenTrait, test_address};
use starkware_utils::constants::MAX_U128;
use starkware_utils_testing::test_utils::{TokenHelperTrait, assert_panic_with_felt_error};

#[test]
#[test_case(Zero::zero())]
#[test_case(constants::DEFAULT_AMOUNT)]
fn test_swap_basic(preexisting_balance: u128) {
    // Setup test environment.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Fund swap executor with input tokens.
    input_token
        .supply(address: test.swap_executor.address, amount: preexisting_balance + swap_amount);

    // Fund AMM with output tokens.
    output_token.supply(address: test.mock_amm, amount: swap_amount);

    // Verify balances before swap.
    assert_eq!(
        input_token.balance_of(address: test.swap_executor.address),
        (preexisting_balance + swap_amount).into(),
    );
    assert_eq!(input_token.balance_of(address: test.mock_amm), 0);
    assert_eq!(output_token.balance_of(address: test.swap_executor.address), 0);
    assert_eq!(output_token.balance_of(address: test.mock_amm), swap_amount.into());

    // Execute swap.
    let received = test
        .swap_executor
        .swap(
            swap_contract: test.mock_amm,
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
        );

    // Verify returned amount is correct (1:1 exchange rate).
    assert_eq!(received, swap_amount);

    // Verify balances after swap.
    assert_eq!(
        input_token.balance_of(address: test.swap_executor.address), preexisting_balance.into(),
    );
    assert_eq!(input_token.balance_of(address: test.mock_amm), swap_amount.into());
    assert_eq!(output_token.balance_of(address: test.swap_executor.address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: test.mock_amm), 0);

    // Verify caller has approval to transfer the received tokens.
    let allowance = IERC20Dispatcher { contract_address: output_token.contract_address() }
        .allowance(owner: test.swap_executor.address, spender: test_address());
    assert_eq!(allowance, swap_amount.into());
}

#[test]
fn test_swap_assertions() {
    use starknet::ContractAddress;

    let test: Test = Default::default();
    let swap_contract = test.mock_amm;
    let swap_selector = selector!("swap");
    let swap_calldata = [].span();
    let in_token: ContractAddress = 'INPUT_TOKEN'.try_into().unwrap();
    let out_token: ContractAddress = 'OUTPUT_TOKEN'.try_into().unwrap();
    let in_amount = 100_u128;

    // ZERO_SWAP_CONTRACT
    let result = test
        .swap_executor
        .safe_swap(
            swap_contract: Zero::zero(),
            :swap_selector,
            :swap_calldata,
            :in_token,
            :out_token,
            :in_amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SWAP_CONTRACT);

    // ZERO_SWAP_SELECTOR
    let result = test
        .swap_executor
        .safe_swap(
            :swap_contract,
            swap_selector: Zero::zero(),
            :swap_calldata,
            :in_token,
            :out_token,
            :in_amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SWAP_SELECTOR);

    // ZERO_IN_TOKEN
    let result = test
        .swap_executor
        .safe_swap(
            :swap_contract,
            :swap_selector,
            :swap_calldata,
            in_token: Zero::zero(),
            :out_token,
            :in_amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_TOKEN);

    // ZERO_OUT_TOKEN
    let result = test
        .swap_executor
        .safe_swap(
            :swap_contract,
            :swap_selector,
            :swap_calldata,
            :in_token,
            out_token: Zero::zero(),
            :in_amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_TOKEN);

    // ZERO_AMOUNT
    let result = test
        .swap_executor
        .safe_swap(
            :swap_contract, :swap_selector, :swap_calldata, :in_token, :out_token, in_amount: 0,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);
}

#[test]
fn test_swap_propagates_amm_error() {
    // Test that errors from the AMM contract are properly propagated.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Verify balances before swap (swap executor intentionally not funded).
    assert_eq!(input_token.balance_of(address: test.swap_executor.address), 0);
    assert_eq!(input_token.balance_of(address: test.mock_amm), 0);
    assert_eq!(output_token.balance_of(address: test.swap_executor.address), 0);
    assert_eq!(output_token.balance_of(address: test.mock_amm), 0);

    // Don't fund swap executor - AMM's transfer_from will fail due to insufficient balance.
    let swap_calldata: Array<felt252> = array![
        input_token.contract_address().into(), output_token.contract_address().into(),
        swap_amount.into(), // amount low
        0 // amount high
    ];
    let result = test
        .swap_executor
        .safe_swap(
            swap_contract: test.mock_amm,
            swap_selector: selector!("swap"),
            swap_calldata: swap_calldata.span(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
        );

    // Verify that the AMM error propagated (swap executor didn't swallow it).
    assert_panic_with_felt_error(:result, expected_error: 'ERC20: insufficient balance');
}

#[test]
fn test_swap_panics_on_zero_out_amount() {
    // Test that when swap returns 0 tokens, the function panics.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Fund swap executor with input tokens.
    input_token.supply(address: test.swap_executor.address, amount: swap_amount);

    // Verify balances before swap.
    assert_eq!(input_token.balance_of(address: test.swap_executor.address), swap_amount.into());
    assert_eq!(input_token.balance_of(address: test.mock_amm), 0);
    assert_eq!(output_token.balance_of(address: test.swap_executor.address), 0);
    assert_eq!(output_token.balance_of(address: test.mock_amm), 0);

    // Call noop_swap which does nothing (returns 0 tokens) - should panic.
    let result = test
        .swap_executor
        .safe_swap(
            swap_contract: test.mock_amm,
            swap_selector: selector!("noop_swap"),
            swap_calldata: [].span(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_AMOUNT);
}

#[test]
fn test_swap_received_amount_overflow() {
    // Test that error is raised when swap returns an amount exceeding u128::MAX.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Fund swap executor with input tokens.
    input_token.supply(address: test.swap_executor.address, amount: swap_amount);

    // Fund AMM with output tokens exceeding u128::MAX.
    // Note: supply takes u128, so we supply MAX_U128 first, then 1 more.
    output_token.supply(address: test.mock_amm, amount: MAX_U128);
    output_token.supply(address: test.mock_amm, amount: 1);

    // Verify balances before swap.
    assert_eq!(input_token.balance_of(address: test.swap_executor.address), swap_amount.into());
    assert_eq!(input_token.balance_of(address: test.mock_amm), 0);
    assert_eq!(output_token.balance_of(address: test.swap_executor.address), 0);
    assert_eq!(output_token.balance_of(address: test.mock_amm), MAX_U128.into() + 1);

    // Call overflow_swap which returns an amount exceeding u128::MAX.
    let swap_calldata = array![output_token.contract_address().into()];
    let result = test
        .swap_executor
        .safe_swap(
            swap_contract: test.mock_amm,
            swap_selector: selector!("overflow_swap"),
            swap_calldata: swap_calldata.span(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::RECEIVED_AMOUNT_OVERFLOW);
}
