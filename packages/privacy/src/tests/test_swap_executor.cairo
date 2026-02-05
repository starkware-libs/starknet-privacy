use core::num::traits::Zero;
use privacy::swap_executor::errors;
use privacy::tests::utils_for_tests::{
    PrivacyCfgTrait, SwapExecutorCfgTrait, Test, TestTrait, UserTrait, constants,
};
use privacy::utils::constants::OPEN_NOTE_SALT;
use privacy::utils::unpacking;
use snforge_std::TokenTrait;
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
            subchannel_index: 0,
        );

    // Create an open note with swap_executor as depositor.
    let create_note_input = user_1
        .new_open_note_with_generated_random(
            recipient: user_2,
            token_addr: output_token.contract_address(),
            index: 0,
            depositor: test.privacy.swap_executor.address,
        );
    user_1.cheat_create_open_note_e2e(:create_note_input);
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
        .swap(
            swap_contract: test.privacy.mock_amm,
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
    // Output tokens should now be in the privacy contract (deposited to open note).
    assert_eq!(output_token.balance_of(address: test.privacy.swap_executor.address), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: test.privacy.mock_amm), 0);

    // Verify the open note was deposited.
    let stored_note = test.privacy.get_note(:note_id);
    let (salt, stored_amount) = unpacking(packed_value: stored_note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, swap_amount);
    assert_eq!(stored_note.token, output_token.contract_address());
    assert_eq!(stored_note.depositor, test.privacy.swap_executor.address);
}

#[test]
fn test_swap_assertions() {
    use starknet::ContractAddress;

    let test: Test = Default::default();
    let swap_contract = test.privacy.mock_amm;
    let swap_selector = selector!("swap");
    let swap_calldata = [].span();
    let in_token: ContractAddress = 'INPUT_TOKEN'.try_into().unwrap();
    let out_token: ContractAddress = 'OUTPUT_TOKEN'.try_into().unwrap();
    let in_amount = 100_u128;
    let note_id: felt252 = 'NOTE_ID';

    // ZERO_SWAP_CONTRACT
    let result = test
        .privacy
        .swap_executor
        .safe_swap(
            swap_contract: Zero::zero(),
            :swap_selector,
            :swap_calldata,
            :in_token,
            :out_token,
            :in_amount,
            :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SWAP_CONTRACT);

    // ZERO_SWAP_SELECTOR
    let result = test
        .privacy
        .swap_executor
        .safe_swap(
            :swap_contract,
            swap_selector: Zero::zero(),
            :swap_calldata,
            :in_token,
            :out_token,
            :in_amount,
            :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SWAP_SELECTOR);

    // ZERO_IN_TOKEN
    let result = test
        .privacy
        .swap_executor
        .safe_swap(
            :swap_contract,
            :swap_selector,
            :swap_calldata,
            in_token: Zero::zero(),
            :out_token,
            :in_amount,
            :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_TOKEN);

    // ZERO_OUT_TOKEN
    let result = test
        .privacy
        .swap_executor
        .safe_swap(
            :swap_contract,
            :swap_selector,
            :swap_calldata,
            :in_token,
            out_token: Zero::zero(),
            :in_amount,
            :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_TOKEN);

    // ZERO_AMOUNT
    let result = test
        .privacy
        .swap_executor
        .safe_swap(
            :swap_contract,
            :swap_selector,
            :swap_calldata,
            :in_token,
            :out_token,
            in_amount: 0,
            :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);

    // ZERO_NOTE_ID
    let result = test
        .privacy
        .swap_executor
        .safe_swap(
            :swap_contract,
            :swap_selector,
            :swap_calldata,
            :in_token,
            :out_token,
            :in_amount,
            note_id: 0,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_NOTE_ID);
}

#[test]
fn test_swap_propagates_amm_error() {
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

    // Don't fund swap executor - AMM's transfer_from will fail due to insufficient balance.
    let swap_calldata: Array<felt252> = array![
        input_token.contract_address().into(), output_token.contract_address().into(),
        swap_amount.into(), // amount low
        0 // amount high
    ];
    let result = test
        .privacy
        .swap_executor
        .safe_swap(
            swap_contract: test.privacy.mock_amm,
            swap_selector: selector!("swap"),
            swap_calldata: swap_calldata.span(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
            :note_id,
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
    let note_id: felt252 = 'NOTE_ID';

    // Fund swap executor with input tokens.
    input_token.supply(address: test.privacy.swap_executor.address, amount: swap_amount);

    // Verify balances before swap.
    assert_eq!(
        input_token.balance_of(address: test.privacy.swap_executor.address), swap_amount.into(),
    );
    assert_eq!(input_token.balance_of(address: test.privacy.mock_amm), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.swap_executor.address), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.mock_amm), 0);

    // Call noop_swap which does nothing (returns 0 tokens) - should panic.
    let result = test
        .privacy
        .swap_executor
        .safe_swap(
            swap_contract: test.privacy.mock_amm,
            swap_selector: selector!("noop_swap"),
            swap_calldata: [].span(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
            :note_id,
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
    let note_id: felt252 = 'NOTE_ID';

    // Fund swap executor with input tokens.
    input_token.supply(address: test.privacy.swap_executor.address, amount: swap_amount);

    // Fund AMM with output tokens exceeding u128::MAX.
    // Note: supply takes u128, so we supply MAX_U128 first, then 1 more.
    output_token.supply(address: test.privacy.mock_amm, amount: MAX_U128);
    output_token.supply(address: test.privacy.mock_amm, amount: 1);

    // Verify balances before swap.
    assert_eq!(
        input_token.balance_of(address: test.privacy.swap_executor.address), swap_amount.into(),
    );
    assert_eq!(input_token.balance_of(address: test.privacy.mock_amm), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.swap_executor.address), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.mock_amm), MAX_U128.into() + 1);

    // Call overflow_swap which returns an amount exceeding u128::MAX.
    let swap_calldata = array![output_token.contract_address().into()];
    let result = test
        .privacy
        .swap_executor
        .safe_swap(
            swap_contract: test.privacy.mock_amm,
            swap_selector: selector!("overflow_swap"),
            swap_calldata: swap_calldata.span(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
            :note_id,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::RECEIVED_AMOUNT_OVERFLOW);
}

#[test]
fn test_swap_caller_not_privacy_contract() {
    // Test that swap fails when caller doesn't implement deposit_to_open_note.
    // The swap itself succeeds but the call to deposit_to_open_note on the caller fails.
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
            subchannel_index: 0,
        );

    // Create an open note with swap_executor as depositor.
    let create_note_input = user_1
        .new_open_note_with_generated_random(
            recipient: user_2,
            token_addr: output_token.contract_address(),
            index: 0,
            depositor: test.privacy.swap_executor.address,
        );
    user_1.cheat_create_open_note_e2e(:create_note_input);
    let (note_id, _) = user_1.compute_open_note(:create_note_input);

    // Verify note exists but is not yet deposited.
    let note_before = test.privacy.get_note(:note_id);
    let (salt_before, amount_before) = unpacking(packed_value: note_before.packed_value);
    assert_eq!(salt_before, OPEN_NOTE_SALT);
    assert_eq!(amount_before, 0);

    // Fund swap executor with input tokens.
    input_token.supply(address: test.privacy.swap_executor.address, amount: swap_amount);

    // Fund AMM with output tokens.
    output_token.supply(address: test.privacy.mock_amm, amount: swap_amount);

    // Execute swap WITHOUT setting caller to privacy contract.
    // The default caller (test_address) doesn't implement IServer, so deposit_to_open_note will
    // fail.
    let result = test
        .privacy
        .swap_executor
        .safe_swap(
            swap_contract: test.privacy.mock_amm,
            swap_selector: selector!("swap"),
            swap_calldata: [
                input_token.contract_address().into(), output_token.contract_address().into(),
                swap_amount.into(), 0,
            ]
                .span(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: swap_amount,
            :note_id,
        );

    // The call fails because the caller doesn't have deposit_to_open_note in its ABI.
    assert_panic_with_felt_error(:result, expected_error: 'ENTRYPOINT_NOT_FOUND');

    // Verify the note was NOT deposited (amount should still be 0).
    let note_after = test.privacy.get_note(:note_id);
    let (salt_after, amount_after) = unpacking(packed_value: note_after.packed_value);
    assert_eq!(salt_after, OPEN_NOTE_SALT);
    assert_eq!(amount_after, 0);
    assert_eq!(note_after.token, output_token.contract_address());
    assert_eq!(note_after.depositor, test.privacy.swap_executor.address);
}
