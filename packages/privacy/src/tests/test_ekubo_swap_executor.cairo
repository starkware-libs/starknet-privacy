//! Tests for the Ekubo swap executor: one helper for multiple pools, pool/route in calldata.

use ekubo::types::keys::PoolKey;
use privacy::ekubo_swap_executor::{IEkuboSwapExecutorDispatcher, IEkuboSwapExecutorDispatcherTrait};
use privacy::tests::utils_for_tests::{
    PrivacyCfgTrait, Test, TestTrait, UserTrait, constants, deploy_ekubo_swap_executor,
    deploy_mock_ekubo_amm,
};
use privacy::utils::constants::OPEN_NOTE_SALT;
use privacy::utils::unpack;
use snforge_std::TokenTrait;
use starkware_utils_testing::test_utils::{TokenHelperTrait, cheat_caller_address_once};

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
    let ekubo_executor = deploy_ekubo_swap_executor(router: mock_router);

    let create_note_input = user_1
        .new_open_note_with_generated_random(
            recipient: user_2,
            token_addr: output_token.contract_address(),
            index: 0,
            depositor: ekubo_executor,
        );
    user_1.cheat_create_open_note_e2e(:create_note_input);
    let (note_id, _) = user_1.compute_open_note(:create_note_input);

    input_token.supply(address: ekubo_executor, amount: swap_amount);
    output_token.supply(address: mock_router, amount: swap_amount);

    let in_addr = input_token.contract_address();
    let out_addr = output_token.contract_address();
    let (token0, token1) = if in_addr < out_addr {
        (in_addr, out_addr)
    } else {
        (out_addr, in_addr)
    };
    let pool_key = PoolKey {
        token0, token1, fee: 0, tick_spacing: 1, extension: 0.try_into().unwrap(),
    };
    let sqrt_ratio_limit: u256 = 0;
    let skip_ahead: u128 = 0;

    cheat_caller_address_once(
        contract_address: ekubo_executor, caller_address: test.privacy.address,
    );
    IEkuboSwapExecutorDispatcher { contract_address: ekubo_executor }
        .privacy_invoke(
            in_token: in_addr,
            out_token: out_addr,
            in_amount: swap_amount,
            note_id: note_id,
            pool_key: pool_key,
            sqrt_ratio_limit: sqrt_ratio_limit,
            skip_ahead: skip_ahead,
        );

    assert_eq!(input_token.balance_of(address: ekubo_executor), 0);
    assert_eq!(input_token.balance_of(address: mock_router), swap_amount.into());
    assert_eq!(output_token.balance_of(address: ekubo_executor), 0);
    assert_eq!(output_token.balance_of(address: mock_router), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.address), swap_amount.into());

    let stored_note = test.privacy.get_note(:note_id);
    let (salt, stored_amount) = unpack(packed_value: stored_note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, swap_amount);
    assert_eq!(stored_note.token, out_addr);
    assert_eq!(stored_note.depositor, ekubo_executor);
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
    let ekubo_executor = deploy_ekubo_swap_executor(router: mock_router);

    let (token0_ab, token1_ab) = if token_a.contract_address() < token_b.contract_address() {
        (token_a.contract_address(), token_b.contract_address())
    } else {
        (token_b.contract_address(), token_a.contract_address())
    };
    let pool_key_ab = PoolKey {
        token0: token0_ab, token1: token1_ab, fee: 0, tick_spacing: 1, extension: mock_router,
    };

    let (token0_ac, token1_ac) = if token_a.contract_address() < token_c.contract_address() {
        (token_a.contract_address(), token_c.contract_address())
    } else {
        (token_c.contract_address(), token_a.contract_address())
    };
    let pool_key_ac = PoolKey {
        token0: token0_ac, token1: token1_ac, fee: 0, tick_spacing: 1, extension: mock_router,
    };

    let create_note_1 = user_1
        .new_open_note_with_generated_random(
            recipient: user_2,
            token_addr: token_b.contract_address(),
            index: 0,
            depositor: ekubo_executor,
        );
    user_1.cheat_create_open_note_e2e(create_note_input: create_note_1);
    let (note_id_1, _) = user_1.compute_open_note(create_note_input: create_note_1);

    let create_note_2 = user_1
        .new_open_note_with_generated_random(
            recipient: user_2,
            token_addr: token_c.contract_address(),
            index: 0,
            depositor: ekubo_executor,
        );
    user_1.cheat_create_open_note_e2e(create_note_input: create_note_2);
    let (note_id_2, _) = user_1.compute_open_note(create_note_input: create_note_2);

    token_a.supply(address: ekubo_executor, amount: swap_amount * 2);
    token_b.supply(address: mock_router, amount: swap_amount);
    token_c.supply(address: mock_router, amount: swap_amount);

    let executor = IEkuboSwapExecutorDispatcher { contract_address: ekubo_executor };

    cheat_caller_address_once(
        contract_address: ekubo_executor, caller_address: test.privacy.address,
    );
    executor
        .privacy_invoke(
            in_token: token_a.contract_address(),
            out_token: token_b.contract_address(),
            in_amount: swap_amount,
            note_id: note_id_1,
            pool_key: pool_key_ab,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
        );

    cheat_caller_address_once(
        contract_address: ekubo_executor, caller_address: test.privacy.address,
    );
    executor
        .privacy_invoke(
            in_token: token_a.contract_address(),
            out_token: token_c.contract_address(),
            in_amount: swap_amount,
            note_id: note_id_2,
            pool_key: pool_key_ac,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
        );

    assert_eq!(token_a.balance_of(address: ekubo_executor), 0);
    let expected_balance: core::integer::u256 = swap_amount.into();
    assert_eq!(token_b.balance_of(address: test.privacy.address), expected_balance);
    assert_eq!(token_c.balance_of(address: test.privacy.address), expected_balance);

    let note_1 = test.privacy.get_note(note_id: note_id_1);
    let (_, amt_1) = unpack(packed_value: note_1.packed_value);
    assert_eq!(amt_1, swap_amount);
    let note_2 = test.privacy.get_note(note_id: note_id_2);
    let (_, amt_2) = unpack(packed_value: note_2.packed_value);
    assert_eq!(amt_2, swap_amount);
}
