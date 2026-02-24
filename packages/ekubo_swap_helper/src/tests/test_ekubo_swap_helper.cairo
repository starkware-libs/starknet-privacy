//! Tests for the Ekubo swap helper: one helper for multiple pools, pool/route in calldata.

use core::num::traits::{Bounded, Zero};
use ekubo::interfaces::router::TokenAmount;
use ekubo::types::i129::i129;
use ekubo_swap_helper::ekubo_swap_helper::errors;
use ekubo_swap_helper::test_utils_contracts::mock_ekubo_amm::{
    IMockEkuboAMMControlDispatcher, IMockEkuboAMMControlDispatcherTrait, SwapBehavior,
};
use ekubo_swap_helper::tests::test_utils::{
    EkuboSwapHelperCfgTrait, deploy_helper_with_router, make_token_amount, new_token,
    pool_key_for_tokens,
};
use privacy::objects::OpenNoteDeposit;
use snforge_std::TokenTrait;
use starkware_utils::constants::MAX_U128;
use starkware_utils_testing::test_utils::{TokenHelperTrait, assert_panic_with_felt_error};

const DEFAULT_AMOUNT: u128 = 100;

#[test]
fn test_ekubo_privacy_invoke_basic() {
    let helper = deploy_helper_with_router();
    let input_token = new_token();
    let output_token = new_token();
    let swap_amount = DEFAULT_AMOUNT;

    input_token.supply(address: helper.address, amount: swap_amount);
    output_token.supply(address: helper.router, amount: swap_amount);

    assert_eq!(input_token.balance_of(address: helper.address), swap_amount.into());
    assert_eq!(input_token.balance_of(address: helper.router), Zero::zero());
    assert_eq!(output_token.balance_of(address: helper.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: helper.router), swap_amount.into());

    let in_addr = input_token.contract_address();
    let out_addr = output_token.contract_address();
    let pool_key = pool_key_for_tokens(in_addr, out_addr);
    let deposits = helper
        .privacy_invoke(
            token_amount: make_token_amount(in_addr, swap_amount),
            :pool_key,
            minimum_received: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    let expected_deposits = [
        OpenNoteDeposit { note_id: 'note', token: out_addr, amount: swap_amount }
    ]
        .span();
    assert_eq!(deposits, expected_deposits);

    assert_eq!(input_token.balance_of(address: helper.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: helper.router), Zero::zero());
    assert_eq!(output_token.balance_of(address: helper.address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: helper.router), Zero::zero());
}

#[test]
fn test_ekubo_same_helper_different_pool() {
    let helper = deploy_helper_with_router();
    let token_a = new_token();
    let token_b = new_token();
    let token_c = new_token();
    let swap_amount = DEFAULT_AMOUNT;

    let pool_key_ab = pool_key_for_tokens(token_a.contract_address(), token_b.contract_address());
    let pool_key_ac = pool_key_for_tokens(token_a.contract_address(), token_c.contract_address());

    token_a.supply(address: helper.address, amount: swap_amount * 2);
    token_b.supply(address: helper.router, amount: swap_amount);
    token_c.supply(address: helper.router, amount: swap_amount);

    helper
        .privacy_invoke(
            token_amount: make_token_amount(token_a.contract_address(), swap_amount),
            pool_key: pool_key_ab,
            minimum_received: 0,
            skip_ahead: 0,
            note_id: 'note_1',
        );

    assert_eq!(token_a.balance_of(address: helper.address), swap_amount.into());
    assert_eq!(token_b.balance_of(address: helper.address), swap_amount.into());
    assert_eq!(token_b.balance_of(address: helper.router), Zero::zero());

    helper
        .privacy_invoke(
            token_amount: make_token_amount(token_a.contract_address(), swap_amount),
            pool_key: pool_key_ac,
            minimum_received: 0,
            skip_ahead: 0,
            note_id: 'note_2',
        );

    assert_eq!(token_a.balance_of(address: helper.address), Zero::zero());
    assert_eq!(token_c.balance_of(address: helper.address), swap_amount.into());
    assert_eq!(token_c.balance_of(address: helper.router), Zero::zero());
}

#[test]
fn test_ekubo_privacy_invoke_assertions() {
    let helper = deploy_helper_with_router();
    let input_token = new_token();
    let output_token = new_token();
    let in_addr = input_token.contract_address();
    let out_addr = output_token.contract_address();
    let pool_key = pool_key_for_tokens(in_addr, out_addr);

    // Catch ZERO_ROUTER.
    let result = helper
        .safe_privacy_invoke(
            router_addr: Zero::zero(),
            token_amount: make_token_amount(in_addr, DEFAULT_AMOUNT),
            :pool_key,
            minimum_received: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ROUTER);

    // Catch ZERO_IN_TOKEN.
    let result = helper
        .safe_privacy_invoke(
            router_addr: helper.router,
            token_amount: make_token_amount(Zero::zero(), DEFAULT_AMOUNT),
            :pool_key,
            minimum_received: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_TOKEN);

    // Catch NEGATIVE_AMOUNT.
    let result = helper
        .safe_privacy_invoke(
            router_addr: helper.router,
            token_amount: TokenAmount {
                token: in_addr, amount: i129 { mag: DEFAULT_AMOUNT, sign: true },
            },
            :pool_key,
            minimum_received: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_AMOUNT);

    // Catch ZERO_IN_AMOUNT.
    let result = helper
        .safe_privacy_invoke(
            router_addr: helper.router,
            token_amount: make_token_amount(in_addr, 0),
            :pool_key,
            minimum_received: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_AMOUNT);

    // Catch TOKEN_MISMATCH_POOL_KEY.
    let unrelated_token = new_token();
    let result = helper
        .safe_privacy_invoke(
            router_addr: helper.router,
            token_amount: make_token_amount(unrelated_token.contract_address(), DEFAULT_AMOUNT),
            :pool_key,
            minimum_received: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::TOKEN_MISMATCH_POOL_KEY);

    // Catch IN_TOKEN_NOT_CLEARED (partial swap leaves input tokens on router).
    let mock_amm_control = IMockEkuboAMMControlDispatcher { contract_address: helper.router };
    mock_amm_control.set_swap_behavior(SwapBehavior::PartialSwap);
    input_token.supply(address: helper.address, amount: DEFAULT_AMOUNT);
    output_token.supply(address: helper.router, amount: DEFAULT_AMOUNT);
    let result = helper
        .safe_privacy_invoke(
            router_addr: helper.router,
            token_amount: make_token_amount(in_addr, DEFAULT_AMOUNT),
            :pool_key,
            minimum_received: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::IN_TOKEN_NOT_CLEARED);

    // Catch ZERO_OUT_AMOUNT (noop swap returns 0 output).
    mock_amm_control.set_swap_behavior(SwapBehavior::Noop);
    input_token.supply(address: helper.address, amount: DEFAULT_AMOUNT);
    output_token.supply(address: helper.router, amount: DEFAULT_AMOUNT);
    let result = helper
        .safe_privacy_invoke(
            router_addr: helper.router,
            token_amount: make_token_amount(in_addr, DEFAULT_AMOUNT),
            :pool_key,
            minimum_received: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_AMOUNT);

    // Catch CLEAR_MINIMUM_NOT_MET (minimum_received exceeds actual output).
    mock_amm_control.set_swap_behavior(SwapBehavior::Normal);
    input_token.supply(address: helper.address, amount: DEFAULT_AMOUNT);
    output_token.supply(address: helper.router, amount: DEFAULT_AMOUNT);
    let result = helper
        .safe_privacy_invoke(
            router_addr: helper.router,
            token_amount: make_token_amount(in_addr, DEFAULT_AMOUNT),
            :pool_key,
            minimum_received: Bounded::<u256>::MAX,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: 'CLEAR_MINIMUM_NOT_MET');

    // Catch RECEIVED_AMOUNT_OVERFLOW (output balance exceeds u128).
    input_token.supply(address: helper.address, amount: DEFAULT_AMOUNT);
    output_token.supply(address: helper.router, amount: MAX_U128);
    output_token.supply(address: helper.router, amount: 1);
    let result = helper
        .safe_privacy_invoke(
            router_addr: helper.router,
            token_amount: make_token_amount(in_addr, DEFAULT_AMOUNT),
            :pool_key,
            minimum_received: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::RECEIVED_AMOUNT_OVERFLOW);
}
