//! Tests for the Ekubo swap helper: one helper for multiple pools, pool/route in calldata.

use core::num::traits::Zero;
use ekubo_swap_helper::ekubo_swap_helper::errors;
use ekubo_swap_helper::test_utils_contracts::mock_ekubo_amm::{
    IMockEkuboAMMControlDispatcher, IMockEkuboAMMControlDispatcherTrait, SwapBehavior,
};
use ekubo_swap_helper::tests::test_utils::{
    EkuboSwapHelperCfg, EkuboSwapHelperCfgTrait, deploy_ekubo_swap_helper, deploy_mock_ekubo_amm,
    pool_key_for_tokens,
};
use snforge_std::{CustomToken, Token, TokenTrait};
use starknet::ContractAddress;
use starkware_utils::constants::MAX_U128;
use starkware_utils_testing::test_utils::{
    Deployable, TokenConfig, TokenHelperTrait, assert_panic_with_felt_error,
};

const DEFAULT_AMOUNT: u128 = 100;

fn deploy_helper_with_router() -> (EkuboSwapHelperCfg, ContractAddress) {
    let mock_router = deploy_mock_ekubo_amm();
    let helper_address = deploy_ekubo_swap_helper();
    let cfg = EkuboSwapHelperCfg { address: helper_address, router: mock_router };
    (cfg, mock_router)
}

fn new_token() -> Token {
    let config = TokenConfig {
        name: "TestToken",
        symbol: "TT",
        decimals: 18,
        initial_supply: 1_000_000_000_000_000_000_000_000_000_000_u256,
        owner: 'TOKEN_OWNER'.try_into().unwrap(),
    };
    let token = config.deploy();
    Token::Custom(
        CustomToken {
            contract_address: token.address,
            balances_variable_selector: selector!("ERC20_balances"),
        },
    )
}

#[test]
fn test_ekubo_privacy_invoke_basic() {
    let (helper, mock_router) = deploy_helper_with_router();
    let input_token = new_token();
    let output_token = new_token();
    let swap_amount = DEFAULT_AMOUNT;

    input_token.supply(address: helper.address, amount: swap_amount);
    output_token.supply(address: mock_router, amount: swap_amount);

    assert_eq!(input_token.balance_of(address: helper.address), swap_amount.into());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: helper.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), swap_amount.into());

    let in_addr = input_token.contract_address();
    let out_addr = output_token.contract_address();
    let pool_key = pool_key_for_tokens(in_addr, out_addr);
    helper
        .privacy_invoke(
            in_token: in_addr,
            out_token: out_addr,
            in_amount: swap_amount,
            :pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            note_id: 'note',
        );

    assert_eq!(input_token.balance_of(address: helper.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), swap_amount.into());
    assert_eq!(output_token.balance_of(address: helper.address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: mock_router), Zero::zero());
}

#[test]
fn test_ekubo_same_helper_different_pool() {
    let (helper, mock_router) = deploy_helper_with_router();
    let token_a = new_token();
    let token_b = new_token();
    let token_c = new_token();
    let swap_amount = DEFAULT_AMOUNT;

    let pool_key_ab = pool_key_for_tokens(token_a.contract_address(), token_b.contract_address());
    let pool_key_ac = pool_key_for_tokens(token_a.contract_address(), token_c.contract_address());

    token_a.supply(address: helper.address, amount: swap_amount * 2);
    token_b.supply(address: mock_router, amount: swap_amount);
    token_c.supply(address: mock_router, amount: swap_amount);

    helper
        .privacy_invoke(
            in_token: token_a.contract_address(),
            out_token: token_b.contract_address(),
            in_amount: swap_amount,
            pool_key: pool_key_ab,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            note_id: 'note_1',
        );

    assert_eq!(token_a.balance_of(address: helper.address), swap_amount.into());
    assert_eq!(token_a.balance_of(address: mock_router), swap_amount.into());
    assert_eq!(token_b.balance_of(address: helper.address), swap_amount.into());
    assert_eq!(token_b.balance_of(address: mock_router), Zero::zero());

    helper
        .privacy_invoke(
            in_token: token_a.contract_address(),
            out_token: token_c.contract_address(),
            in_amount: swap_amount,
            pool_key: pool_key_ac,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            note_id: 'note_2',
        );

    assert_eq!(token_a.balance_of(address: helper.address), Zero::zero());
    assert_eq!(token_a.balance_of(address: mock_router), (swap_amount * 2).into());
    assert_eq!(token_c.balance_of(address: helper.address), swap_amount.into());
    assert_eq!(token_c.balance_of(address: mock_router), Zero::zero());
}

#[test]
fn test_ekubo_privacy_invoke_assert_zero_router() {
    let (helper, _mock_router) = deploy_helper_with_router();
    let input_token = new_token();
    let output_token = new_token();
    let pool_key = pool_key_for_tokens(
        input_token.contract_address(), output_token.contract_address(),
    );
    let result = helper
        .safe_privacy_invoke(
            router_addr: Zero::zero(),
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: DEFAULT_AMOUNT,
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ROUTER);
}

#[test]
fn test_ekubo_privacy_invoke_assert_zero_in_token() {
    let (helper, mock_router) = deploy_helper_with_router();
    let input_token = new_token();
    let output_token = new_token();
    let pool_key = pool_key_for_tokens(
        input_token.contract_address(), output_token.contract_address(),
    );
    let result = helper
        .safe_privacy_invoke(
            router_addr: mock_router,
            in_token: Zero::zero(),
            out_token: output_token.contract_address(),
            in_amount: DEFAULT_AMOUNT,
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_TOKEN);
}

#[test]
fn test_ekubo_privacy_invoke_assert_zero_out_token() {
    let (helper, mock_router) = deploy_helper_with_router();
    let input_token = new_token();
    let output_token = new_token();
    let pool_key = pool_key_for_tokens(
        input_token.contract_address(), output_token.contract_address(),
    );
    let result = helper
        .safe_privacy_invoke(
            router_addr: mock_router,
            in_token: input_token.contract_address(),
            out_token: Zero::zero(),
            in_amount: DEFAULT_AMOUNT,
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_TOKEN);
}

#[test]
fn test_ekubo_privacy_invoke_assert_zero_in_amount() {
    let (helper, mock_router) = deploy_helper_with_router();
    let input_token = new_token();
    let output_token = new_token();
    let pool_key = pool_key_for_tokens(
        input_token.contract_address(), output_token.contract_address(),
    );
    let result = helper
        .safe_privacy_invoke(
            router_addr: mock_router,
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: 0,
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_IN_AMOUNT);
}

#[test]
fn test_ekubo_privacy_invoke_assert_in_token_equal_to_out_token() {
    let (helper, mock_router) = deploy_helper_with_router();
    let input_token = new_token();
    let output_token = new_token();
    let addr = input_token.contract_address();
    let pool_key = pool_key_for_tokens(addr, output_token.contract_address());
    let result = helper
        .safe_privacy_invoke(
            router_addr: mock_router,
            in_token: addr,
            out_token: addr,
            in_amount: DEFAULT_AMOUNT,
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::IN_TOKEN_EQUAL_TO_OUT_TOKEN);
}

#[test]
fn test_ekubo_privacy_invoke_assert_token_mismatch_pool() {
    let (helper, mock_router) = deploy_helper_with_router();
    let token_a = new_token();
    let token_b = new_token();
    let token_c = new_token();
    let pool_key = pool_key_for_tokens(token_a.contract_address(), token_b.contract_address());
    let result = helper
        .safe_privacy_invoke(
            router_addr: mock_router,
            in_token: token_a.contract_address(),
            out_token: token_c.contract_address(),
            in_amount: DEFAULT_AMOUNT,
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::TOKEN_MISMATCH_POOL);
}

#[test]
fn test_ekubo_privacy_invoke_assert_zero_out_amount() {
    let mock_router = deploy_mock_ekubo_amm();
    IMockEkuboAMMControlDispatcher { contract_address: mock_router }
        .set_swap_behavior(SwapBehavior::Noop);
    let helper_address = deploy_ekubo_swap_helper();
    let helper = EkuboSwapHelperCfg { address: helper_address, router: mock_router };
    let input_token = new_token();
    let output_token = new_token();
    let amount = DEFAULT_AMOUNT;
    input_token.supply(address: helper.address, amount: amount);
    output_token.supply(address: mock_router, amount: amount);
    let pool_key = pool_key_for_tokens(
        input_token.contract_address(), output_token.contract_address(),
    );
    let result = helper
        .safe_privacy_invoke(
            router_addr: mock_router,
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: amount,
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_AMOUNT);
    // After revert: no state change (helper still has in, mock still has out).
    assert_eq!(input_token.balance_of(address: helper.address), amount.into());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: helper.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), amount.into());
}

#[test]
fn test_ekubo_privacy_invoke_assert_received_amount_overflow() {
    let (helper, mock_router) = deploy_helper_with_router();
    let input_token = new_token();
    let output_token = new_token();
    let amount = DEFAULT_AMOUNT;
    input_token.supply(address: helper.address, amount: amount);
    output_token.supply(address: mock_router, amount: MAX_U128);
    output_token.supply(address: mock_router, amount: 1);
    let pool_key = pool_key_for_tokens(
        input_token.contract_address(), output_token.contract_address(),
    );
    let overflow_balance: u256 = MAX_U128.into() + 1;
    assert_eq!(output_token.balance_of(address: mock_router), overflow_balance);
    let result = helper
        .safe_privacy_invoke(
            router_addr: mock_router,
            in_token: input_token.contract_address(),
            out_token: output_token.contract_address(),
            in_amount: amount,
            pool_key: pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            note_id: 'note',
        );
    assert_panic_with_felt_error(:result, expected_error: errors::RECEIVED_AMOUNT_OVERFLOW);
    assert_eq!(input_token.balance_of(address: helper.address), amount.into());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: helper.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), overflow_balance);
}
