use core::num::traits::{Bounded, Zero};
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::interface::IViewsDispatcherTrait;
use snforge_std::{TokenTrait, set_balance};
use starkware_utils_testing::test_utils::{assert_panic_with_felt_error, cheat_caller_address_once};
use swap_executor::errors;
use swap_executor::tests::mock_amm::RATE_DENOMINATOR;
use swap_executor::tests::test_utils::{
    PrivacyCfgTrait, SwapExecutorCfgTrait, Test, TestTrait, compute_open_note_packed_value,
    constants, deploy_mock_amm,
};

#[test]
fn test_swap_and_deposit_basic() {
    // Setup test environment.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Create open note directly in storage with swap_executor as depositor.
    let note_id = test
        .privacy
        .cheat_create_open_note(
            token: output_token.contract_address(), depositor: test.swap_executor.address,
        );

    // Verify note was created with zero amount.
    let views = test.privacy.get_views_dispatcher();
    let initial_note = views.get_note(:note_id);
    let expected_initial_packed = compute_open_note_packed_value(amount: 0);
    assert_eq!(initial_note.packed_value, expected_initial_packed);

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

    // Execute swap and deposit.
    test
        .swap_executor
        .swap_and_deposit(
            swap_contract: test.mock_amm.address,
            swap_selector: selector!("swap"),
            swap_calldata: swap_calldata.span(),
            input_token: input_token.contract_address(),
            output_token: output_token.contract_address(),
            amount: swap_amount,
            :note_id,
        );

    // Verify open note was filled with swap amount (1:1 exchange rate).
    let filled_note = views.get_note(:note_id);
    let expected_filled_packed = compute_open_note_packed_value(amount: swap_amount);
    assert_eq!(filled_note.packed_value, expected_filled_packed);

    // Verify privacy contract received the output tokens.
    let privacy_balance = IERC20Dispatcher { contract_address: output_token.contract_address() }
        .balance_of(account: test.swap_executor.privacy_address);
    assert_eq!(privacy_balance, swap_amount.into());
}

#[test]
fn test_swap_and_deposit_different_exchange_rate() {
    // Setup test environment.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Deploy mock AMM with 50% exchange rate.
    let exchange_rate = RATE_DENOMINATOR / 2;
    let amm = deploy_mock_amm(:exchange_rate);
    let expected_output: u128 = (swap_amount.into() * exchange_rate / RATE_DENOMINATOR)
        .try_into()
        .unwrap();

    // Create open note directly in storage with swap_executor as depositor.
    let note_id = test
        .privacy
        .cheat_create_open_note(
            token: output_token.contract_address(), depositor: test.swap_executor.address,
        );

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

    // Execute swap and deposit.
    test
        .swap_executor
        .swap_and_deposit(
            swap_contract: amm.address,
            swap_selector: selector!("swap"),
            swap_calldata: swap_calldata.span(),
            input_token: input_token.contract_address(),
            output_token: output_token.contract_address(),
            amount: swap_amount,
            :note_id,
        );

    // Verify open note was filled with correct amount (50% exchange rate).
    let views = test.privacy.get_views_dispatcher();
    let filled_note = views.get_note(:note_id);
    let expected_filled_packed = compute_open_note_packed_value(amount: expected_output);
    assert_eq!(filled_note.packed_value, expected_filled_packed);

    // Verify privacy contract received the correct amount of output tokens.
    let privacy_balance = IERC20Dispatcher { contract_address: output_token.contract_address() }
        .balance_of(account: test.swap_executor.privacy_address);
    assert_eq!(privacy_balance, expected_output.into());
}

#[test]
fn test_swap_and_deposit_assertions() {
    use starknet::ContractAddress;

    let test: Test = Default::default();
    let valid_swap_contract = test.mock_amm.address;
    let valid_selector = selector!("swap");
    let valid_calldata = array![0];
    let valid_input_token: ContractAddress = 'INPUT_TOKEN'.try_into().unwrap();
    let valid_output_token: ContractAddress = 'OUTPUT_TOKEN'.try_into().unwrap();
    let valid_amount = 100_u128;
    let valid_note_id = 'NOTE_ID';

    // INVALID_CALLER: Don't cheat caller.
    let result = test
        .swap_executor
        .safe_swap_and_deposit(
            swap_contract: valid_swap_contract,
            swap_selector: valid_selector,
            swap_calldata: valid_calldata.span(),
            input_token: valid_input_token,
            output_token: valid_output_token,
            amount: valid_amount,
            note_id: valid_note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CALLER);

    // ZERO_SWAP_CONTRACT
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );
    let result = test
        .swap_executor
        .safe_swap_and_deposit(
            swap_contract: Zero::zero(),
            swap_selector: valid_selector,
            swap_calldata: valid_calldata.span(),
            input_token: valid_input_token,
            output_token: valid_output_token,
            amount: valid_amount,
            note_id: valid_note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SWAP_CONTRACT);

    // ZERO_SWAP_SELECTOR
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );
    let result = test
        .swap_executor
        .safe_swap_and_deposit(
            swap_contract: valid_swap_contract,
            swap_selector: Zero::zero(),
            swap_calldata: valid_calldata.span(),
            input_token: valid_input_token,
            output_token: valid_output_token,
            amount: valid_amount,
            note_id: valid_note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SWAP_SELECTOR);

    // EMPTY_SWAP_CALLDATA
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );
    let empty_calldata: Array<felt252> = array![];
    let result = test
        .swap_executor
        .safe_swap_and_deposit(
            swap_contract: valid_swap_contract,
            swap_selector: valid_selector,
            swap_calldata: empty_calldata.span(),
            input_token: valid_input_token,
            output_token: valid_output_token,
            amount: valid_amount,
            note_id: valid_note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::EMPTY_SWAP_CALLDATA);

    // ZERO_INPUT_TOKEN
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );
    let result = test
        .swap_executor
        .safe_swap_and_deposit(
            swap_contract: valid_swap_contract,
            swap_selector: valid_selector,
            swap_calldata: valid_calldata.span(),
            input_token: Zero::zero(),
            output_token: valid_output_token,
            amount: valid_amount,
            note_id: valid_note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_INPUT_TOKEN);

    // ZERO_OUTPUT_TOKEN
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );
    let result = test
        .swap_executor
        .safe_swap_and_deposit(
            swap_contract: valid_swap_contract,
            swap_selector: valid_selector,
            swap_calldata: valid_calldata.span(),
            input_token: valid_input_token,
            output_token: Zero::zero(),
            amount: valid_amount,
            note_id: valid_note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUTPUT_TOKEN);

    // ZERO_AMOUNT
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );
    let result = test
        .swap_executor
        .safe_swap_and_deposit(
            swap_contract: valid_swap_contract,
            swap_selector: valid_selector,
            swap_calldata: valid_calldata.span(),
            input_token: valid_input_token,
            output_token: valid_output_token,
            amount: 0,
            note_id: valid_note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);

    // ZERO_NOTE_ID
    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );
    let result = test
        .swap_executor
        .safe_swap_and_deposit(
            swap_contract: valid_swap_contract,
            swap_selector: valid_selector,
            swap_calldata: valid_calldata.span(),
            input_token: valid_input_token,
            output_token: valid_output_token,
            amount: valid_amount,
            note_id: Zero::zero(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_NOTE_ID);
}

#[test]
fn test_swap_and_deposit_propagates_amm_error() {
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
        .safe_swap_and_deposit(
            swap_contract: test.mock_amm.address,
            swap_selector: selector!("failing_swap"),
            swap_calldata: [0].span(),
            input_token: input_token.contract_address(),
            output_token: output_token.contract_address(),
            amount: constants::DEFAULT_AMOUNT,
            note_id: 'NOTE_ID',
        );
    assert_panic_with_felt_error(:result, expected_error: 'SWAP_FAILED');
}

#[test]
fn test_swap_and_deposit_zero_received_skips_deposit() {
    // Test that when swap returns 0 tokens, no deposit is attempted.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Create open note.
    let note_id = test
        .privacy
        .cheat_create_open_note(
            token: output_token.contract_address(), depositor: test.swap_executor.address,
        );

    // Fund swap executor with input tokens.
    set_balance(
        target: test.swap_executor.address, new_balance: swap_amount.into(), token: input_token,
    );

    cheat_caller_address_once(
        contract_address: test.swap_executor.address,
        caller_address: test.swap_executor.privacy_address,
    );

    // Call noop_swap which does nothing (returns 0 tokens).
    test
        .swap_executor
        .swap_and_deposit(
            swap_contract: test.mock_amm.address,
            swap_selector: selector!("noop_swap"),
            swap_calldata: [0].span(),
            input_token: input_token.contract_address(),
            output_token: output_token.contract_address(),
            amount: swap_amount,
            :note_id,
        );

    // Verify note is still empty (no deposit was made).
    let views = test.privacy.get_views_dispatcher();
    let note = views.get_note(:note_id);
    let expected_packed = compute_open_note_packed_value(amount: 0);
    assert_eq!(note.packed_value, expected_packed);
}

#[test]
fn test_swap_and_deposit_with_preexisting_balance() {
    // Test that only the received amount (balance diff) is deposited, not pre-existing balance.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let preexisting_balance: u256 = 500;

    // Create open note.
    let note_id = test
        .privacy
        .cheat_create_open_note(
            token: output_token.contract_address(), depositor: test.swap_executor.address,
        );

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

    test
        .swap_executor
        .swap_and_deposit(
            swap_contract: test.mock_amm.address,
            swap_selector: selector!("swap"),
            swap_calldata: swap_calldata.span(),
            input_token: input_token.contract_address(),
            output_token: output_token.contract_address(),
            amount: swap_amount,
            :note_id,
        );

    // Verify note was filled with only the swap amount, not preexisting + swap.
    let views = test.privacy.get_views_dispatcher();
    let note = views.get_note(:note_id);
    let expected_packed = compute_open_note_packed_value(amount: swap_amount);
    assert_eq!(note.packed_value, expected_packed);

    // Verify swap executor still has the pre-existing balance (it was transferred to privacy).
    // Privacy should have received swap_amount, swap_executor keeps preexisting_balance.
    let executor_balance = IERC20Dispatcher { contract_address: output_token.contract_address() }
        .balance_of(account: test.swap_executor.address);
    assert_eq!(executor_balance, preexisting_balance);
}

#[test]
fn test_swap_and_deposit_note_not_found() {
    // Test that error propagates when note doesn't exist.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Don't create any note - use a non-existent note_id.
    let note_id = 'NON_EXISTENT_NOTE';

    // Fund swap executor and AMM.
    set_balance(
        target: test.swap_executor.address, new_balance: swap_amount.into(), token: input_token,
    );
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

    let result = test
        .swap_executor
        .safe_swap_and_deposit(
            swap_contract: test.mock_amm.address,
            swap_selector: selector!("swap"),
            swap_calldata: swap_calldata.span(),
            input_token: input_token.contract_address(),
            output_token: output_token.contract_address(),
            amount: swap_amount,
            :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: 'NOTE_NOT_FOUND');
}

#[test]
fn test_swap_and_deposit_wrong_depositor() {
    // Test that error propagates when swap_executor is not the note's depositor.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Create open note with a DIFFERENT depositor (not swap_executor).
    let wrong_depositor: starknet::ContractAddress = 'SOMEONE_ELSE'.try_into().unwrap();
    let note_id = test
        .privacy
        .cheat_create_open_note(token: output_token.contract_address(), depositor: wrong_depositor);

    // Fund swap executor and AMM.
    set_balance(
        target: test.swap_executor.address, new_balance: swap_amount.into(), token: input_token,
    );
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

    let result = test
        .swap_executor
        .safe_swap_and_deposit(
            swap_contract: test.mock_amm.address,
            swap_selector: selector!("swap"),
            swap_calldata: swap_calldata.span(),
            input_token: input_token.contract_address(),
            output_token: output_token.contract_address(),
            amount: swap_amount,
            :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: 'CALLER_NOT_DEPOSITOR');
}

#[test]
fn test_swap_and_deposit_received_amount_overflow() {
    // Test that error is raised when swap returns an amount exceeding u128::MAX.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;

    // Create open note.
    let note_id = test
        .privacy
        .cheat_create_open_note(
            token: output_token.contract_address(), depositor: test.swap_executor.address,
        );

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
        .safe_swap_and_deposit(
            swap_contract: test.mock_amm.address,
            swap_selector: selector!("overflow_swap"),
            swap_calldata: swap_calldata.span(),
            input_token: input_token.contract_address(),
            output_token: output_token.contract_address(),
            amount: swap_amount,
            :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::RECEIVED_AMOUNT_OVERFLOW);
}

#[test]
fn test_get_privacy_pool() {
    let test: Test = Default::default();
    assert_eq!(test.swap_executor.get_privacy_pool(), test.privacy.address);
}
