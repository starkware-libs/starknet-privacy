//! Integration tests for the Ekubo swap helper with the privacy contract.

use core::num::traits::Zero;
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::actions::{ClientAction, InvokeExternalInput};
use privacy::tests::utils_for_tests::{
    EkuboSwapHelperCfgTrait, PrivacyCfgTrait, Test, TestTrait, UserTrait,
    build_ekubo_swap_helper_calldata, constants, deploy_ekubo_swap_helper, deploy_mock_ekubo_amm,
    pool_key_for_tokens,
};
use privacy::utils::constants::OPEN_NOTE_SALT;
use privacy::utils::unpack;
use snforge_std::TokenTrait;
use starkware_utils_testing::test_utils::TokenHelperTrait;

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
    let ekubo_helper = deploy_ekubo_swap_helper(
        router: mock_router, privacy_address: test.privacy.address,
    );

    let create_note_input = user_1
        .new_open_note_with_generated_random(
            recipient: user_2, token_addr: output_token.contract_address(), index: 0,
        );
    user_1.cheat_create_open_note(:create_note_input);
    let (note_id, _) = user_1.compute_open_note(:create_note_input);

    input_token.supply(address: ekubo_helper.address, amount: swap_amount);
    output_token.supply(address: mock_router, amount: swap_amount);

    // Balances before swap: helper holds in, mock holds out, privacy holds nothing.
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: ekubo_helper.address), swap_amount.into());
    assert_eq!(input_token.balance_of(address: mock_router), Zero::zero());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: ekubo_helper.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), swap_amount.into());

    let in_addr = input_token.contract_address();
    let out_addr = output_token.contract_address();
    let pool_key = pool_key_for_tokens(in_addr, out_addr);
    ekubo_helper
        .privacy_invoke(
            in_token: in_addr,
            out_token: out_addr,
            in_amount: swap_amount,
            :pool_key,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            :note_id,
        );

    // Balances after swap: in moved to mock, out moved to helper (approved for privacy).
    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: ekubo_helper.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), swap_amount.into());
    assert_eq!(output_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: ekubo_helper.address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: mock_router), Zero::zero());

    let out_erc20 = IERC20Dispatcher { contract_address: out_addr };
    assert_eq!(
        out_erc20.allowance(owner: ekubo_helper.address, spender: test.privacy.address),
        swap_amount.into(),
    );
}

#[test]
fn test_ekubo_same_helper_different_pool() {
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
    let ekubo_helper = deploy_ekubo_swap_helper(
        router: mock_router, privacy_address: test.privacy.address,
    );

    let pool_key_ab = pool_key_for_tokens(token_a.contract_address(), token_b.contract_address());
    let pool_key_ac = pool_key_for_tokens(token_a.contract_address(), token_c.contract_address());

    let create_note_1 = user_1
        .new_open_note_with_generated_random(
            recipient: user_2, token_addr: token_b.contract_address(), index: 0,
        );
    user_1.cheat_create_open_note(create_note_input: create_note_1);
    let (note_id_1, _) = user_1.compute_open_note(create_note_input: create_note_1);

    let create_note_2 = user_1
        .new_open_note_with_generated_random(
            recipient: user_2, token_addr: token_c.contract_address(), index: 0,
        );
    user_1.cheat_create_open_note(create_note_input: create_note_2);
    let (note_id_2, _) = user_1.compute_open_note(create_note_input: create_note_2);

    token_a.supply(address: ekubo_helper.address, amount: swap_amount * 2);
    token_b.supply(address: mock_router, amount: swap_amount);
    token_c.supply(address: mock_router, amount: swap_amount);

    ekubo_helper
        .privacy_invoke(
            in_token: token_a.contract_address(),
            out_token: token_b.contract_address(),
            in_amount: swap_amount,
            pool_key: pool_key_ab,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            note_id: note_id_1,
        );

    assert_eq!(token_a.balance_of(address: ekubo_helper.address), swap_amount.into());
    assert_eq!(token_b.balance_of(address: ekubo_helper.address), swap_amount.into());

    ekubo_helper
        .privacy_invoke(
            in_token: token_a.contract_address(),
            out_token: token_c.contract_address(),
            in_amount: swap_amount,
            pool_key: pool_key_ac,
            sqrt_ratio_limit: 0,
            skip_ahead: 0,
            note_id: note_id_2,
        );

    assert_eq!(token_a.balance_of(address: ekubo_helper.address), Zero::zero());
    assert_eq!(token_a.balance_of(address: mock_router), (swap_amount * 2).into());
    assert_eq!(token_c.balance_of(address: ekubo_helper.address), swap_amount.into());
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
    let ekubo_helper = deploy_ekubo_swap_helper(
        router: mock_router, privacy_address: test.privacy.address,
    );

    let create_note_input = user_1
        .new_open_note_with_generated_random(
            recipient: user_2, token_addr: output_token.contract_address(), index: 0,
        );
    let (note_id, _) = user_1.compute_open_note(:create_note_input);

    input_token.supply(address: ekubo_helper.address, amount: swap_amount);
    output_token.supply(address: mock_router, amount: swap_amount);

    let in_addr = input_token.contract_address();
    let out_addr = output_token.contract_address();
    let pool_key = pool_key_for_tokens(in_addr, out_addr);
    let calldata = build_ekubo_swap_helper_calldata(
        router_addr: mock_router,
        in_token: in_addr,
        out_token: out_addr,
        in_amount: swap_amount,
        :pool_key,
        sqrt_ratio_limit: 0,
        skip_ahead: 0,
        :note_id,
    );
    let invoke_external_input = InvokeExternalInput {
        contract_address: ekubo_helper.address, calldata: calldata.span(),
    };
    let client_actions = [
        ClientAction::CreateOpenNote(create_note_input),
        ClientAction::InvokeExternal(invoke_external_input),
    ]
        .span();
    let server_actions = user_1.execute(client_actions: client_actions);
    test.privacy.apply_actions(actions: server_actions);

    assert_eq!(input_token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: ekubo_helper.address), Zero::zero());
    assert_eq!(input_token.balance_of(address: mock_router), swap_amount.into());
    assert_eq!(output_token.balance_of(address: test.privacy.address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: ekubo_helper.address), Zero::zero());
    assert_eq!(output_token.balance_of(address: mock_router), Zero::zero());

    let stored_note = test.privacy.get_note(:note_id);
    let (salt, stored_amount) = unpack(packed_value: stored_note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, swap_amount);
    assert_eq!(stored_note.token, out_addr);
}
