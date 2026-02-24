//! Tests for the Ekubo swap executor: one helper for multiple pools, pool/route in calldata.

use core::num::traits::Zero;
use privacy::actions::{ClientAction, InvokeExternalInput};
use privacy::ekubo_swap_executor::ekubo_swap_executor::EkuboSwapExecutor;
use privacy::ekubo_swap_executor::errors;
use privacy::tests::mock_ekubo_amm::{
    IMockEkuboAMMControlDispatcher, IMockEkuboAMMControlDispatcherTrait, SwapBehavior,
};
use privacy::tests::utils_for_tests::{
    EkuboSwapExecutorCfgTrait, PrivacyCfgTrait, Test, TestTrait, UserTrait,
    build_ekubo_swap_executor_calldata, constants, deploy_ekubo_swap_executor,
    deploy_mock_ekubo_amm, pool_key_for_tokens,
};
use privacy::utils::constants::OPEN_NOTE_SALT;
use privacy::utils::unpack;
use snforge_std::TokenTrait;
use starkware_utils::constants::MAX_U128;
use starkware_utils_testing::test_utils::{TokenHelperTrait, assert_panic_with_felt_error};

#[test]
fn test_ekubo_privacy_invoke_basic() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();

    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2,
            token_addr: output_token.contract_address(),
            outgoing_channel_index: 0,
        );

    let mock_router = deploy_mock_ekubo_amm();
    let ekubo_executor = deploy_ekubo_swap_executor(
        router: mock_router, privacy_address: test.privacy.address,
    );

    let create_note_input = user_1
        .new_open_note_with_generated_random(
            recipient: user_2,
            token_addr: output_token.contract_address(),
            index: 0,
            depositor: ekubo_executor.address,
        );
    user_1.cheat_create_open_note_e2e(:create_note_input);
    let (note_id, _) = user_1.compute_open_note(:create_note_input);

    input_token.supply(address: ekubo_executor.address, amount: swap_amount);
    output_token.supply(address: mock_router, amount: swap_amount);

    // Balances before swap: executor holds in, mock holds out, privacy holds nothing.
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: ekubo_executor.address), swap_amount.into());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: ekubo_executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), swap_amount.into());

    let in_addr = input_token.contract_address();
    let out_addr = output_token.contract_address();
    let pool_key = pool_key_for_tokens(in_addr, out_addr);
    ekubo_executor
        .privacy_invoke(
            in_token: in_addr,
            out_token: out_addr,
            in_amount: swap_amount,
            :note_id,
            :pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
        );

    // Balances after swap: in moved to mock, out moved to privacy; executor holds nothing.
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: ekubo_executor.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), swap_amount.into());
    assert_eq!(output_token.balance_of(address: test.privacy.address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: ekubo_executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), Zero::zero());

    let stored_note = test.privacy.get_note(:note_id);
    let (salt, stored_amount) = unpack(packed_value: stored_note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, swap_amount);
    assert_eq!(stored_note.token, out_addr);
    assert_eq!(stored_note.depositor, ekubo_executor.address);
}

#[test]
fn test_ekubo_same_executor_different_pool() {
    let mut test: Test = Default::default();
    let token_a = test.new_token();
    let token_b = test.new_token();
    let token_c = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();

    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, token_addr: token_b.contract_address(), outgoing_channel_index: 0,
        );
    user_1.open_subchannel_e2e(recipient: user_2, token_addr: token_c.contract_address(), index: 1);

    let mock_router = deploy_mock_ekubo_amm();
    let ekubo_executor = deploy_ekubo_swap_executor(
        router: mock_router, privacy_address: test.privacy.address,
    );

    let pool_key_ab = pool_key_for_tokens(token_a.contract_address(), token_b.contract_address());
    let pool_key_ac = pool_key_for_tokens(token_a.contract_address(), token_c.contract_address());

    let create_note_1 = user_1
        .new_open_note_with_generated_random(
            recipient: user_2,
            token_addr: token_b.contract_address(),
            index: 0,
            depositor: ekubo_executor.address,
        );
    user_1.cheat_create_open_note_e2e(create_note_input: create_note_1);
    let (note_id_1, _) = user_1.compute_open_note(create_note_input: create_note_1);

    let create_note_2 = user_1
        .new_open_note_with_generated_random(
            recipient: user_2,
            token_addr: token_c.contract_address(),
            index: 0,
            depositor: ekubo_executor.address,
        );
    user_1.cheat_create_open_note_e2e(create_note_input: create_note_2);
    let (note_id_2, _) = user_1.compute_open_note(create_note_input: create_note_2);

    token_a.supply(address: ekubo_executor.address, amount: swap_amount * 2);
    token_b.supply(address: mock_router, amount: swap_amount);
    token_c.supply(address: mock_router, amount: swap_amount);

    // Balances before first swap: executor has 2*A, mock has B and C, privacy has nothing.
    assert_eq!(token_a.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token_a.balance_of(address: ekubo_executor.address), (swap_amount * 2).into());
    assert_eq!(token_a.balance_of(address: mock_router), Zero::zero());
    assert_eq!(token_b.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token_b.balance_of(address: ekubo_executor.address), Zero::zero());
    assert_eq!(token_b.balance_of(address: mock_router), swap_amount.into());
    assert_eq!(token_c.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token_c.balance_of(address: ekubo_executor.address), Zero::zero());
    assert_eq!(token_c.balance_of(address: mock_router), swap_amount.into());

    ekubo_executor
        .privacy_invoke(
            in_token: token_a.contract_address(),
            out_token: token_b.contract_address(),
            in_amount: swap_amount,
            note_id: note_id_1,
            pool_key: pool_key_ab,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
        );

    // After first swap: executor has A, mock has A+B (C unchanged), privacy has B.
    assert_eq!(token_a.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token_a.balance_of(address: ekubo_executor.address), swap_amount.into());
    assert_eq!(token_a.balance_of(address: mock_router), swap_amount.into());
    assert_eq!(token_b.balance_of(address: test.privacy.address), swap_amount.into());
    assert_eq!(token_b.balance_of(address: ekubo_executor.address), Zero::zero());
    assert_eq!(token_b.balance_of(address: mock_router), Zero::zero());
    assert_eq!(token_c.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token_c.balance_of(address: ekubo_executor.address), Zero::zero());
    assert_eq!(token_c.balance_of(address: mock_router), swap_amount.into());

    ekubo_executor
        .privacy_invoke(
            in_token: token_a.contract_address(),
            out_token: token_c.contract_address(),
            in_amount: swap_amount,
            note_id: note_id_2,
            pool_key: pool_key_ac,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
        );

    // After second swap: executor 0, mock has 2*A, privacy has B and C.
    assert_eq!(token_a.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token_a.balance_of(address: ekubo_executor.address), Zero::zero());
    assert_eq!(token_a.balance_of(address: mock_router), (swap_amount * 2).into());
    assert_eq!(token_b.balance_of(address: test.privacy.address), swap_amount.into());
    assert_eq!(token_b.balance_of(address: ekubo_executor.address), Zero::zero());
    assert_eq!(token_b.balance_of(address: mock_router), Zero::zero());
    assert_eq!(token_c.balance_of(address: test.privacy.address), swap_amount.into());
    assert_eq!(token_c.balance_of(address: ekubo_executor.address), Zero::zero());
    assert_eq!(token_c.balance_of(address: mock_router), Zero::zero());

    let note_1 = test.privacy.get_note(note_id: note_id_1);
    let (_, amt_1) = unpack(packed_value: note_1.packed_value);
    assert_eq!(amt_1, swap_amount);
    let note_2 = test.privacy.get_note(note_id: note_id_2);
    let (_, amt_2) = unpack(packed_value: note_2.packed_value);
    assert_eq!(amt_2, swap_amount);
}

#[test]
fn test_ekubo_privacy_invoke_assert_zero_in_token() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let mock_router = deploy_mock_ekubo_amm();
    let executor = deploy_ekubo_swap_executor(
        router: mock_router, privacy_address: test.privacy.address,
    );
    let pool_key = pool_key_for_tokens(
        input_token.contract_address(), output_token.contract_address(),
    );
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), Zero::zero());
    let result = executor
        .safe_privacy_invoke(
            in_token: Zero::zero(),
            out_token: output_token.contract_address(),
            in_amount: constants::DEFAULT_AMOUNT,
            note_id: 'note',
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_TOKEN);
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), Zero::zero());
}

#[test]
fn test_ekubo_privacy_invoke_assert_zero_out_token() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let mock_router = deploy_mock_ekubo_amm();
    let executor = deploy_ekubo_swap_executor(
        router: mock_router, privacy_address: test.privacy.address,
    );
    let pool_key = pool_key_for_tokens(
        input_token.contract_address(), output_token.contract_address(),
    );
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), Zero::zero());
    let result = executor
        .safe_privacy_invoke(
            in_token: input_token.contract_address(),
            out_token: Zero::zero(),
            in_amount: constants::DEFAULT_AMOUNT,
            note_id: 'note',
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_TOKEN);
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), Zero::zero());
}

#[test]
fn test_ekubo_privacy_invoke_assert_zero_in_amount() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let mock_router = deploy_mock_ekubo_amm();
    let executor = deploy_ekubo_swap_executor(
        router: mock_router, privacy_address: test.privacy.address,
    );
    let pool_key = pool_key_for_tokens(
        input_token.contract_address(), output_token.contract_address(),
    );
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), Zero::zero());
    let result = executor
        .safe_privacy_invoke(
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: 0,
            note_id: 'note',
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_AMOUNT);
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), Zero::zero());
}

#[test]
fn test_ekubo_privacy_invoke_assert_in_token_equal_to_out_token() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let mock_router = deploy_mock_ekubo_amm();
    let executor = deploy_ekubo_swap_executor(
        router: mock_router, privacy_address: test.privacy.address,
    );
    let addr = input_token.contract_address();
    let pool_key = pool_key_for_tokens(addr, output_token.contract_address());
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), Zero::zero());
    let result = executor
        .safe_privacy_invoke(
            in_token: addr,
            out_token: addr,
            in_amount: constants::DEFAULT_AMOUNT,
            note_id: 'note',
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::IN_TOKEN_EQUAL_TO_OUT_TOKEN);
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), Zero::zero());
}

#[test]
fn test_ekubo_privacy_invoke_assert_token_mismatch_pool() {
    let mut test: Test = Default::default();
    let token_a = test.new_token();
    let token_b = test.new_token();
    let token_c = test.new_token();
    let mock_router = deploy_mock_ekubo_amm();
    let executor = deploy_ekubo_swap_executor(
        router: mock_router, privacy_address: test.privacy.address,
    );
    let pool_key = pool_key_for_tokens(token_a.contract_address(), token_b.contract_address());
    assert_eq!(token_a.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token_a.balance_of(address: executor.address), Zero::zero());
    assert_eq!(token_a.balance_of(address: mock_router), Zero::zero());
    assert_eq!(token_b.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token_b.balance_of(address: executor.address), Zero::zero());
    assert_eq!(token_b.balance_of(address: mock_router), Zero::zero());
    assert_eq!(token_c.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token_c.balance_of(address: executor.address), Zero::zero());
    assert_eq!(token_c.balance_of(address: mock_router), Zero::zero());
    let result = executor
        .safe_privacy_invoke(
            in_token: token_a.contract_address(),
            out_token: token_c.contract_address(),
            in_amount: constants::DEFAULT_AMOUNT,
            note_id: 'note',
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::TOKEN_MISMATCH_POOL);
    assert_eq!(token_a.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token_a.balance_of(address: executor.address), Zero::zero());
    assert_eq!(token_a.balance_of(address: mock_router), Zero::zero());
    assert_eq!(token_b.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token_b.balance_of(address: executor.address), Zero::zero());
    assert_eq!(token_b.balance_of(address: mock_router), Zero::zero());
    assert_eq!(token_c.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token_c.balance_of(address: executor.address), Zero::zero());
    assert_eq!(token_c.balance_of(address: mock_router), Zero::zero());
}

#[test]
fn test_ekubo_privacy_invoke_assert_insufficient_balance() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let mock_router = deploy_mock_ekubo_amm();
    let executor = deploy_ekubo_swap_executor(
        router: mock_router, privacy_address: test.privacy.address,
    );
    let amount = constants::DEFAULT_AMOUNT;
    output_token.supply(address: mock_router, amount: amount);
    let pool_key = pool_key_for_tokens(
        input_token.contract_address(), output_token.contract_address(),
    );
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), amount.into());
    let result = executor
        .safe_privacy_invoke(
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: amount,
            note_id: 'note',
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INSUFFICIENT_BALANCE);
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), amount.into());
}

#[test]
fn test_ekubo_privacy_invoke_assert_zero_out_amount() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let mock_router = deploy_mock_ekubo_amm();
    IMockEkuboAMMControlDispatcher { contract_address: mock_router }
        .set_swap_behavior(SwapBehavior::Noop);
    let executor = deploy_ekubo_swap_executor(
        router: mock_router, privacy_address: test.privacy.address,
    );
    let amount = constants::DEFAULT_AMOUNT;
    input_token.supply(address: executor.address, amount: amount);
    output_token.supply(address: mock_router, amount: amount);
    let pool_key = pool_key_for_tokens(
        input_token.contract_address(), output_token.contract_address(),
    );
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), amount.into());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), amount.into());
    let result = executor
        .safe_privacy_invoke(
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: amount,
            note_id: 'note',
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_AMOUNT);
    // After revert: no state change (executor still has in, mock still has out).
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), amount.into());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), amount.into());
}

#[test]
fn test_ekubo_privacy_invoke_assert_received_amount_overflow() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let mock_router = deploy_mock_ekubo_amm();
    let executor = deploy_ekubo_swap_executor(
        router: mock_router, privacy_address: test.privacy.address,
    );
    let amount = constants::DEFAULT_AMOUNT;
    input_token.supply(address: executor.address, amount: amount);
    output_token.supply(address: mock_router, amount: MAX_U128);
    output_token.supply(address: mock_router, amount: 1);
    let pool_key = pool_key_for_tokens(
        input_token.contract_address(), output_token.contract_address(),
    );
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), amount.into());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    let overflow_balance: u256 = MAX_U128.into() + 1;
    assert_eq!(output_token.balance_of(address: mock_router), overflow_balance);
    let result = executor
        .safe_privacy_invoke(
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: amount,
            note_id: 'note',
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::RECEIVED_AMOUNT_OVERFLOW);
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor.address), amount.into());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), overflow_balance);
}

#[test]
fn test_ekubo_privacy_invoke_via_privacy_contract() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();

    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2,
            token_addr: output_token.contract_address(),
            outgoing_channel_index: 0,
        );

    let mock_router = deploy_mock_ekubo_amm();
    let ekubo_executor = deploy_ekubo_swap_executor(
        router: mock_router, privacy_address: test.privacy.address,
    );

    let create_note_input = user_1
        .new_open_note_with_generated_random(
            recipient: user_2,
            token_addr: output_token.contract_address(),
            index: 0,
            depositor: ekubo_executor.address,
        );
    let (note_id, _) = user_1.compute_open_note(:create_note_input);

    input_token.supply(address: ekubo_executor.address, amount: swap_amount);
    output_token.supply(address: mock_router, amount: swap_amount);

    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: ekubo_executor.address), swap_amount.into());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: ekubo_executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), swap_amount.into());

    let in_addr = input_token.contract_address();
    let out_addr = output_token.contract_address();
    let pool_key = pool_key_for_tokens(in_addr, out_addr);
    let calldata = build_ekubo_swap_executor_calldata(
        in_token: in_addr,
        out_token: out_addr,
        in_amount: swap_amount,
        :note_id,
        :pool_key,
        sqrt_ratio_limit: 0,
        skip_ahead: 0,
    );
    let invoke_external_input = InvokeExternalInput {
        contract_address: ekubo_executor.address, calldata: calldata.span(),
    };
    let client_actions = [
        ClientAction::CreateOpenNote(create_note_input),
        ClientAction::InvokeExternal(invoke_external_input),
    ]
        .span();
    let server_actions = user_1.execute(client_actions: client_actions);
    test.privacy.apply_actions(actions: server_actions);

    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: ekubo_executor.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), swap_amount.into());
    assert_eq!(output_token.balance_of(address: test.privacy.address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: ekubo_executor.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), Zero::zero());

    let stored_note = test.privacy.get_note(:note_id);
    let (salt, stored_amount) = unpack(packed_value: stored_note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, swap_amount);
    assert_eq!(stored_note.token, out_addr);
    assert_eq!(stored_note.depositor, ekubo_executor.address);
}

#[test]
fn test_ekubo_swap_executor_constructor() {
    let mut test: Test = Default::default();
    let mock_router = deploy_mock_ekubo_amm();
    let ekubo_executor = deploy_ekubo_swap_executor(
        router: mock_router, privacy_address: test.privacy.address,
    );
    assert_eq!(ekubo_executor.get_router(), mock_router);
}

#[test]
fn test_ekubo_swap_executor_set_router() {
    let mut test: Test = Default::default();
    let initial_router = deploy_mock_ekubo_amm();
    let ekubo_executor = deploy_ekubo_swap_executor(
        router: initial_router, privacy_address: test.privacy.address,
    );

    assert_eq!(ekubo_executor.get_router(), initial_router);

    let new_router = test.privacy.address;
    ekubo_executor.set_router(router: new_router);

    assert_eq!(ekubo_executor.get_router(), new_router);
}

#[test]
#[should_panic(expected: 'ZERO_ROUTER')]
fn test_ekubo_swap_executor_constructor_zero_router() {
    let mut state = EkuboSwapExecutor::contract_state_for_testing();
    EkuboSwapExecutor::constructor(ref state, router: Zero::zero());
}

