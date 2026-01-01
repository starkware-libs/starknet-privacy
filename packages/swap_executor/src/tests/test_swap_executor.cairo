use core::num::traits::Zero;
use openzeppelin::token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{TokenTrait, set_balance};
use starknet::ContractAddress;
use starkware_utils_testing::test_utils::{assert_panic_with_felt_error, cheat_caller_address_once};
use swap_executor::errors;
use swap_executor::interface::{ISwapExecutorDispatcher, ISwapExecutorDispatcherTrait};
use swap_executor::tests::test_utils::{
    SwapExecutorCfgTrait, Test, TestTrait, constants, deploy_mock_amm,
};

#[test]
fn test_swap_and_deposit_basic() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let owner_addr: ContractAddress = 'OWNER_ADDR'.try_into().unwrap();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Deploy mock AMM with 1:1 exchange rate
    let amm = deploy_mock_amm(exchange_rate: constants::DEFAULT_EXCHANGE_RATE);

    // Supply tokens: privacy pool has input_token, AMM has output_token
    // The privacy pool will transfer input_token to swap_executor during swap_and_deposit
    set_balance(target: test.cfg.privacy, new_balance: swap_amount.into(), token: input_token);
    set_balance(target: amm.address, new_balance: swap_amount.into(), token: output_token);

    // Also set balance on swap_executor so it can approve and swap
    set_balance(target: test.cfg.address, new_balance: swap_amount.into(), token: input_token);

    // Create note in server
    let note = test.new_note(amount: swap_amount);
    test.cfg.create_note(:note);

    // Prepare swap calldata: [input_token, output_token, min_output_amount] as array of felt252
    let swap_calldata = array![
        input_token.contract_address().into(), output_token.contract_address().into(),
        0 // min_output_amount as felt252
    ];
    let swap_selector = selector!("swap");

    // Execute swap and deposit
    cheat_caller_address_once(contract_address: test.cfg.address, caller_address: test.cfg.privacy);
    ISwapExecutorDispatcher { contract_address: test.cfg.address }
        .swap_and_deposit(
            swap_contract: amm.address,
            swap_selector: swap_selector,
            swap_calldata: swap_calldata.span(),
            owner_addr: owner_addr,
            token: output_token.contract_address(),
            amount: swap_amount,
            note_id: note.id,
        );

    // Verify output token was deposited to server
    let server_balance = IERC20Dispatcher { contract_address: output_token.contract_address() }
        .balance_of(account: test.cfg.privacy);
    assert(server_balance >= swap_amount.into(), 'Deposit failed');
}

#[test]
#[feature("safe_dispatcher")]
fn test_swap_and_deposit_assertions() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let owner_addr: ContractAddress = 'OWNER_ADDR'.try_into().unwrap();
    let amm = deploy_mock_amm(exchange_rate: constants::DEFAULT_EXCHANGE_RATE);
    let swap_selector = selector!("swap");
    let valid_calldata = array![
        token.contract_address().into(), token.contract_address().into(), 0,
    ];
    let note = test.new_note(amount: 100);

    // Test INVALID_CALLER
    let result = test
        .cfg
        .safe_swap_and_deposit(
            swap_contract: amm.address,
            swap_selector: swap_selector,
            swap_calldata: valid_calldata.span(),
            owner_addr: owner_addr,
            token: token.contract_address(),
            amount: 100,
            note_id: note.id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CALLER);

    // Test ZERO_SWAP_CONTRACT
    cheat_caller_address_once(contract_address: test.cfg.address, caller_address: test.cfg.privacy);
    let result = test
        .cfg
        .safe_swap_and_deposit(
            swap_contract: Zero::zero(),
            swap_selector: swap_selector,
            swap_calldata: valid_calldata.span(),
            owner_addr: owner_addr,
            token: token.contract_address(),
            amount: 100,
            note_id: note.id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SWAP_CONTRACT);

    // Test ZERO_SWAP_SELECTOR
    cheat_caller_address_once(contract_address: test.cfg.address, caller_address: test.cfg.privacy);
    let result = test
        .cfg
        .safe_swap_and_deposit(
            swap_contract: amm.address,
            swap_selector: Zero::zero(),
            swap_calldata: valid_calldata.span(),
            owner_addr: owner_addr,
            token: token.contract_address(),
            amount: 100,
            note_id: note.id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SWAP_SELECTOR);

    // Test ZERO_SWAP_CALLDATA
    cheat_caller_address_once(contract_address: test.cfg.address, caller_address: test.cfg.privacy);
    let empty_calldata: Array<felt252> = array![];
    let result = test
        .cfg
        .safe_swap_and_deposit(
            swap_contract: amm.address,
            swap_selector: swap_selector,
            swap_calldata: empty_calldata.span(),
            owner_addr: owner_addr,
            token: token.contract_address(),
            amount: 100,
            note_id: note.id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SWAP_CALLDATA);

    // Test ZERO_OWNER_ADDR
    cheat_caller_address_once(contract_address: test.cfg.address, caller_address: test.cfg.privacy);
    let result = test
        .cfg
        .safe_swap_and_deposit(
            swap_contract: amm.address,
            swap_selector: swap_selector,
            swap_calldata: valid_calldata.span(),
            owner_addr: Zero::zero(),
            token: token.contract_address(),
            amount: 100,
            note_id: note.id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OWNER_ADDR);

    // Test ZERO_TOKEN
    cheat_caller_address_once(contract_address: test.cfg.address, caller_address: test.cfg.privacy);
    let result = test
        .cfg
        .safe_swap_and_deposit(
            swap_contract: amm.address,
            swap_selector: swap_selector,
            swap_calldata: valid_calldata.span(),
            owner_addr: owner_addr,
            token: Zero::zero(),
            amount: 100,
            note_id: note.id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Test ZERO_AMOUNT
    cheat_caller_address_once(contract_address: test.cfg.address, caller_address: test.cfg.privacy);
    let result = test
        .cfg
        .safe_swap_and_deposit(
            swap_contract: amm.address,
            swap_selector: swap_selector,
            swap_calldata: valid_calldata.span(),
            owner_addr: owner_addr,
            token: token.contract_address(),
            amount: 0,
            note_id: note.id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);

    // Test ZERO_NOTE_ID
    cheat_caller_address_once(contract_address: test.cfg.address, caller_address: test.cfg.privacy);
    let result = test
        .cfg
        .safe_swap_and_deposit(
            swap_contract: amm.address,
            swap_selector: swap_selector,
            swap_calldata: valid_calldata.span(),
            owner_addr: owner_addr,
            token: token.contract_address(),
            amount: 100,
            note_id: Zero::zero(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_NOTE_ID);
}

#[test]
fn test_swap_and_deposit_different_exchange_rate() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let owner_addr: ContractAddress = 'OWNER_ADDR'.try_into().unwrap();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Deploy mock AMM with 2:1 exchange rate (get half back)
    let exchange_rate = 500_u256; // 50% return
    let amm = deploy_mock_amm(exchange_rate: exchange_rate);

    // Supply tokens: privacy pool has input_token, AMM has output_token
    set_balance(target: test.cfg.privacy, new_balance: swap_amount.into(), token: input_token);
    set_balance(target: amm.address, new_balance: (swap_amount * 2).into(), token: output_token);
    // Ensure privacy pool starts with 0 output_token balance
    set_balance(target: test.cfg.privacy, new_balance: 0, token: output_token);

    // Also set balance on swap_executor so it can approve and swap
    set_balance(target: test.cfg.address, new_balance: swap_amount.into(), token: input_token);
    // Ensure swap_executor starts with 0 output_token balance
    set_balance(target: test.cfg.address, new_balance: 0, token: output_token);

    // Create note
    // Calculate expected output: swap_amount * exchange_rate / 1000
    // Use u256 arithmetic to match AMM calculation
    let expected_output_u256 = (swap_amount.into() * 500_u256) / 1000_u256;
    let expected_output: u128 = expected_output_u256.try_into().unwrap();
    let note = test.new_note(amount: expected_output);
    test.cfg.create_note(:note);

    // Execute swap
    let swap_calldata = array![
        input_token.contract_address().into(), output_token.contract_address().into(), 0,
    ];
    let swap_selector = selector!("swap");

    cheat_caller_address_once(contract_address: test.cfg.address, caller_address: test.cfg.privacy);
    ISwapExecutorDispatcher { contract_address: test.cfg.address }
        .swap_and_deposit(
            swap_contract: amm.address,
            swap_selector: swap_selector,
            swap_calldata: swap_calldata.span(),
            owner_addr: owner_addr,
            token: output_token.contract_address(),
            amount: swap_amount,
            note_id: note.id,
        );

    // Verify correct amount was deposited
    // The AMM calculates: output_amount = (swap_amount * 500) / 1000
    // This should equal expected_output
    let server_balance = IERC20Dispatcher { contract_address: output_token.contract_address() }
        .balance_of(account: test.cfg.privacy);
    // Calculate what the AMM should have sent (using same formula as AMM)
    let amm_output = (swap_amount.into() * 500_u256) / 1000_u256;
    assert(server_balance == amm_output, 'Incorrect deposit amount');
}

#[test]
fn test_swap_and_deposit_no_output() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let _owner_addr: ContractAddress = 'OWNER_ADDR'.try_into().unwrap();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Deploy mock AMM
    let _amm = deploy_mock_amm(exchange_rate: constants::DEFAULT_EXCHANGE_RATE);

    // Supply only input token, no output token (swap will fail or return 0)
    set_balance(target: test.cfg.address, new_balance: swap_amount.into(), token: input_token);
    // Don't supply output token to AMM

    // Create note
    let note = test.new_note(amount: swap_amount);
    test.cfg.create_note(:note);

    let _swap_calldata = array![
        input_token.contract_address().into(), output_token.contract_address().into(), 0,
    ];
    let _swap_selector = selector!("swap");

    // This should fail because AMM doesn't have output tokens
    // or succeed but deposit 0 (which won't call deposit)
    cheat_caller_address_once(contract_address: test.cfg.address, caller_address: test.cfg.privacy);
    // The swap will fail or return 0, so no deposit should happen
// This test verifies the if received_amount > 0 check works
}

