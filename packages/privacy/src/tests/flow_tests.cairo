use core::num::traits::Zero;
use privacy::errors;
use privacy::hashes::compute_note_id;
use privacy::tests::utils_for_tests::{
    PrivacyCfgTrait, Test, TestTrait, UserFlowTrait, UserTrait, constants,
};
use snforge_std::TokenTrait;
use starkware_utils_testing::test_utils::assert_panic_with_felt_error;
use super::utils_for_tests::PrivacyTokenTrait;

// Open Channel Flows
#[test]
#[test_case(true)]
#[test_case(false)]
fn test_open_channel_flow(self_channel: bool) {
    let mut test: Test = Default::default();
    let mut recipient = test.new_user();
    let mut sender = if self_channel {
        @recipient
    } else {
        @test.new_user()
    };
    let channel_id = sender.compute_channel_id(recipient: @recipient);

    if !self_channel {
        assert_eq!(sender.get_num_of_channels(), 0);
    }
    assert_eq!(recipient.get_num_of_channels(), 0);
    assert!(!test.privacy.channel_exists(:channel_id));

    sender.open_channel_flow(ref :recipient);

    if !self_channel {
        assert_eq!(sender.get_num_of_channels(), 0);
    }
    assert_eq!(recipient.get_num_of_channels(), 1);
    assert!(test.privacy.channel_exists(:channel_id));
}

#[test]
fn test_open_2_channels_in_succession_flow() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let channel_id_1_to_2 = user_1.compute_channel_id(recipient: @user_2);
    let channel_id_1_to_3 = user_1.compute_channel_id(recipient: @user_3);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 0);
    assert_eq!(user_3.get_num_of_channels(), 0);
    assert!(!test.privacy.channel_exists(channel_id: channel_id_1_to_2));
    assert!(!test.privacy.channel_exists(channel_id: channel_id_1_to_3));

    user_1.open_channel_flow(ref recipient: user_2);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 1);
    assert_eq!(user_3.get_num_of_channels(), 0);
    assert!(test.privacy.channel_exists(channel_id: channel_id_1_to_2));
    assert!(!test.privacy.channel_exists(channel_id: channel_id_1_to_3));

    user_1.open_channel_flow(ref recipient: user_3);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 1);
    assert_eq!(user_3.get_num_of_channels(), 1);
    assert!(test.privacy.channel_exists(channel_id: channel_id_1_to_2));
    assert!(test.privacy.channel_exists(channel_id: channel_id_1_to_3));
}

#[test]
fn test_open_same_channel_twice_flow() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let channel_id = user_1.compute_channel_id(recipient: @user_2);
    let random = user_1.get_random().into();
    let open_channel_actions = user_1.open_channel(recipient: @user_2, :random);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 0);
    assert!(!test.privacy.channel_exists(:channel_id));

    test.privacy.execute_actions(actions: open_channel_actions);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 1);
    assert!(test.privacy.channel_exists(:channel_id));

    let result = user_1.safe_open_channel(recipient: @user_2, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 1);
    assert!(test.privacy.channel_exists(:channel_id));

    let result = test.privacy.safe_execute_actions(actions: open_channel_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 1);
    assert!(test.privacy.channel_exists(:channel_id));
}

#[test]
fn test_open_channel_before_recipient_registered_flow() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    let channel_id = user_1.compute_channel_id(recipient: @user_2);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 0);
    assert!(!test.privacy.channel_exists(:channel_id));

    let result = user_1.safe_open_channel(recipient: @user_2, random: user_1.get_random().into());
    assert_panic_with_felt_error(:result, expected_error: errors::VALUE_MISMATCH);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 0);
    assert!(!test.privacy.channel_exists(:channel_id));
}

#[test]
fn test_open_channel_wrong_sender_key_flow() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    let channel_id_old_key = user_1.compute_channel_id(recipient: @user_2);
    user_1.new_key();
    let channel_id_new_key = user_1.compute_channel_id(recipient: @user_2);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 0);
    assert!(!test.privacy.channel_exists(channel_id: channel_id_old_key));
    assert!(!test.privacy.channel_exists(channel_id: channel_id_new_key));

    let result = user_1.safe_open_channel(recipient: @user_2, random: user_1.get_random().into());
    assert_panic_with_felt_error(:result, expected_error: errors::SENDER_NOT_AUTHENTICATED);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 0);
    assert!(!test.privacy.channel_exists(channel_id: channel_id_old_key));
    assert!(!test.privacy.channel_exists(channel_id: channel_id_new_key));
}

// Open Subchannel Flows
#[test]
fn test_open_subchannel_flow() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let subchannel_id = user_1
        .compute_subchannel_id(recipient: @user_2, token_address: token.contract_address());

    assert!(!test.privacy.subchannel_exists(:subchannel_id));

    user_1.open_subchannel_flow(ref recipient: user_2, :token);

    assert!(test.privacy.subchannel_exists(:subchannel_id));
}

#[test]
fn test_open_subchannels_in_succession_flow() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_1 = test.new_token();
    let token_2 = test.new_token();
    let token_3 = test.new_token();
    let subchannel_id_1 = user_1
        .compute_subchannel_id(recipient: @user_2, token_address: token_1.contract_address());
    let subchannel_id_2 = user_1
        .compute_subchannel_id(recipient: @user_2, token_address: token_2.contract_address());
    let subchannel_id_3 = user_1
        .compute_subchannel_id(recipient: @user_2, token_address: token_3.contract_address());

    assert!(!test.privacy.subchannel_exists(subchannel_id: subchannel_id_1));
    assert!(!test.privacy.subchannel_exists(subchannel_id: subchannel_id_2));
    assert!(!test.privacy.subchannel_exists(subchannel_id: subchannel_id_3));

    user_1.open_subchannel_flow(ref recipient: user_2, token: token_1);

    assert!(test.privacy.subchannel_exists(subchannel_id: subchannel_id_1));
    assert!(!test.privacy.subchannel_exists(subchannel_id: subchannel_id_2));
    assert!(!test.privacy.subchannel_exists(subchannel_id: subchannel_id_3));

    user_1.open_subchannel_flow(ref recipient: user_2, token: token_2);

    assert!(test.privacy.subchannel_exists(subchannel_id: subchannel_id_1));
    assert!(test.privacy.subchannel_exists(subchannel_id: subchannel_id_2));
    assert!(!test.privacy.subchannel_exists(subchannel_id: subchannel_id_3));

    user_1.open_subchannel_flow(ref recipient: user_2, token: token_3);

    assert!(test.privacy.subchannel_exists(subchannel_id: subchannel_id_1));
    assert!(test.privacy.subchannel_exists(subchannel_id: subchannel_id_2));
    assert!(test.privacy.subchannel_exists(subchannel_id: subchannel_id_3));
}

#[test]
#[test_case(true, true)]
#[test_case(true, false)]
#[test_case(false, true)]
fn test_open_subchannel_twice_flow(same_index: bool, same_token: bool) {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_1 = test.new_token();
    let token_2 = if same_token {
        token_1
    } else {
        test.new_token()
    };
    let index_1 = 0;
    let index_2 = if same_index {
        index_1
    } else {
        index_1 + 1
    };
    let subchannel_id = user_1
        .compute_subchannel_id(recipient: @user_2, token_address: token_1.contract_address());
    user_1.open_channel_flow(ref recipient: user_2);
    let random = user_1.get_random().into();
    let actions = user_1
        .open_subchannel(
            recipient: @user_2, token_address: token_1.contract_address(), index: index_1, :random,
        );

    assert!(!test.privacy.subchannel_exists(:subchannel_id));

    test.privacy.execute_actions(:actions);

    assert!(test.privacy.subchannel_exists(:subchannel_id));

    let result = user_1
        .safe_open_subchannel(
            recipient: @user_2,
            token_address: token_2.contract_address(),
            index: index_2,
            random: user_1.get_random().into(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    assert!(test.privacy.subchannel_exists(:subchannel_id));
}

#[test]
fn test_open_subchannel_server_actions_twice_flow() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let random = user_1.get_random().into();
    let channel_id = user_1.compute_channel_id(recipient: @user_2);
    let subchannel_id = user_1
        .compute_subchannel_id(recipient: @user_2, token_address: token.contract_address());
    let index = user_1.channel_indices.get(channel_id);

    user_1.open_channel_flow(ref recipient: user_2);
    let actions = user_1
        .open_subchannel(
            recipient: @user_2, token_address: token.contract_address(), :index, :random,
        );

    assert!(!test.privacy.subchannel_exists(:subchannel_id));
    test.privacy.execute_actions(:actions);
    assert!(test.privacy.subchannel_exists(:subchannel_id));

    let result = test.privacy.safe_execute_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    assert!(test.privacy.subchannel_exists(:subchannel_id));
}

#[test]
fn test_open_subchannel_non_sequential_index_flow() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_1 = test.new_token();
    let token_2 = test.new_token();
    let channel_id = user_1.compute_channel_id(recipient: @user_2);
    let subchannel_id_1 = user_1
        .compute_subchannel_id(recipient: @user_2, token_address: token_1.contract_address());
    let subchannel_id_2 = user_1
        .compute_subchannel_id(recipient: @user_2, token_address: token_2.contract_address());

    // Fill index 0.
    user_1.open_subchannel_flow(ref recipient: user_2, token: token_1);
    let proper_index = user_2.channel_indices.get(channel_id);
    assert_eq!(proper_index, 1);

    assert!(test.privacy.subchannel_exists(subchannel_id: subchannel_id_1));
    assert!(!test.privacy.subchannel_exists(subchannel_id: subchannel_id_2));

    // Try again with index 0.
    let result = user_1
        .safe_open_subchannel(
            recipient: @user_2,
            token_address: token_2.contract_address(),
            index: proper_index - 1,
            random: user_1.get_random().into(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    assert!(test.privacy.subchannel_exists(subchannel_id: subchannel_id_1));
    assert!(!test.privacy.subchannel_exists(subchannel_id: subchannel_id_2));

    // Try with index 2.
    let result = user_1
        .safe_open_subchannel(
            recipient: @user_2,
            token_address: token_2.contract_address(),
            index: proper_index + 1,
            random: user_1.get_random().into(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);

    assert!(test.privacy.subchannel_exists(subchannel_id: subchannel_id_1));
    assert!(!test.privacy.subchannel_exists(subchannel_id: subchannel_id_2));

    // Open index 1.
    user_1
        .open_subchannel_e2e(
            recipient: @user_2, token_address: token_2.contract_address(), index: proper_index,
        );

    assert!(test.privacy.subchannel_exists(subchannel_id: subchannel_id_1));
    assert!(test.privacy.subchannel_exists(subchannel_id: subchannel_id_2));
}

#[test]
fn test_open_subchannel_before_channel_opened_flow() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let channel_id = user_1.compute_channel_id(recipient: @user_2);
    let subchannel_id = user_1
        .compute_subchannel_id(recipient: @user_2, token_address: token.contract_address());

    assert!(!test.privacy.channel_exists(:channel_id));
    assert!(!test.privacy.subchannel_exists(:subchannel_id));

    // Open subchannel before channel is opened.
    let result = user_1
        .safe_open_subchannel(
            recipient: @user_2,
            token_address: token.contract_address(),
            index: 0,
            random: user_1.get_random().into(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    assert!(!test.privacy.channel_exists(:channel_id));
    assert!(!test.privacy.subchannel_exists(:subchannel_id));

    // Open channel.
    user_1.open_channel_flow(ref recipient: user_2);

    assert!(test.privacy.channel_exists(:channel_id));
    assert!(!test.privacy.subchannel_exists(:subchannel_id));

    // Open subchannel.
    user_1
        .open_subchannel_e2e(recipient: @user_2, token_address: token.contract_address(), index: 0);

    assert!(test.privacy.channel_exists(:channel_id));
    assert!(test.privacy.subchannel_exists(:subchannel_id));
}

// Deposit Flows
#[test]
#[test_case(true)]
#[test_case(false)]
fn test_deposit_flow(self_deposit: bool) {
    let mut test: Test = Default::default();
    let mut recipient = test.new_user();
    let depositor = if self_deposit {
        @recipient
    } else {
        @test.new_user()
    };
    let token = test.new_token();
    let amount = constants::DEFAULT_AMOUNT;
    token.supply(address: *depositor.address, :amount);

    assert_eq!(token.balance_of(address: *depositor.address), amount.into());
    if !self_deposit {
        assert_eq!(token.balance_of(address: recipient.address), Zero::zero());
    }
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    depositor.deposit_flow(ref :recipient, :token, :amount);

    assert_eq!(token.balance_of(address: *depositor.address), Zero::zero());
    if !self_deposit {
        assert_eq!(token.balance_of(address: recipient.address), Zero::zero());
    }
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
}

fn test_deposit_server_actions_twice_flow() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let amount = constants::DEFAULT_AMOUNT;
    user.open_subchannel_flow(ref recipient: user, :token);
    token.supply(address: user.address, :amount);

    let server_actions = user
        .compile_client_actions_revert(
            client_actions: [user.deposit_action(:token, :amount)].span(),
        );

    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    test.privacy.execute_actions(actions: server_actions);

    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    let result = test.privacy.safe_execute_actions(actions: server_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
}

#[test]
#[test_case(false, false)]
#[test_case(false, true)]
#[test_case(true, false)]
#[test_case(true, true)]
fn test_multiple_deposits_flow(same_token: bool, self_deposit: bool) {
    let mut test: Test = Default::default();
    let mut recipient = test.new_user();
    let depositor = if self_deposit {
        @recipient
    } else {
        @test.new_user()
    };
    let token_1 = test.new_token();
    let token_2 = if same_token {
        token_1
    } else {
        test.new_token()
    };
    let token_3 = if same_token {
        token_1
    } else {
        test.new_token()
    };
    let amount = constants::DEFAULT_AMOUNT;
    token_1.supply(address: *depositor.address, :amount);
    token_2.supply(address: *depositor.address, :amount);
    token_3.supply(address: *depositor.address, :amount);

    if same_token {
        assert_eq!(token_1.balance_of(address: *depositor.address), amount.into() * 3);
        if !self_deposit {
            assert_eq!(token_1.balance_of(address: recipient.address), Zero::zero());
        }
        assert_eq!(token_1.balance_of(address: test.privacy.address), Zero::zero());
    } else {
        assert_eq!(token_1.balance_of(address: *depositor.address), amount.into());
        assert_eq!(token_2.balance_of(address: *depositor.address), amount.into());
        assert_eq!(token_3.balance_of(address: *depositor.address), amount.into());
        if !self_deposit {
            assert_eq!(token_1.balance_of(address: recipient.address), Zero::zero());
            assert_eq!(token_2.balance_of(address: recipient.address), Zero::zero());
            assert_eq!(token_3.balance_of(address: recipient.address), Zero::zero());
        }
        assert_eq!(token_1.balance_of(address: test.privacy.address), Zero::zero());
        assert_eq!(token_2.balance_of(address: test.privacy.address), Zero::zero());
        assert_eq!(token_3.balance_of(address: test.privacy.address), Zero::zero());
    }

    depositor.deposit_flow(ref :recipient, token: token_1, :amount);

    if same_token {
        assert_eq!(token_1.balance_of(address: *depositor.address), amount.into() * 2);
        if !self_deposit {
            assert_eq!(token_1.balance_of(address: recipient.address), Zero::zero());
        }
        assert_eq!(token_1.balance_of(address: test.privacy.address), amount.into());
    } else {
        assert_eq!(token_1.balance_of(address: *depositor.address), Zero::zero());
        assert_eq!(token_2.balance_of(address: *depositor.address), amount.into());
        assert_eq!(token_3.balance_of(address: *depositor.address), amount.into());
        if !self_deposit {
            assert_eq!(token_1.balance_of(address: recipient.address), Zero::zero());
            assert_eq!(token_2.balance_of(address: recipient.address), Zero::zero());
            assert_eq!(token_3.balance_of(address: recipient.address), Zero::zero());
        }
        assert_eq!(token_1.balance_of(address: test.privacy.address), amount.into());
        assert_eq!(token_2.balance_of(address: test.privacy.address), Zero::zero());
        assert_eq!(token_3.balance_of(address: test.privacy.address), Zero::zero());
    }

    depositor.deposit_flow(ref :recipient, token: token_2, :amount);

    if same_token {
        assert_eq!(token_1.balance_of(address: *depositor.address), amount.into());
        if !self_deposit {
            assert_eq!(token_1.balance_of(address: recipient.address), Zero::zero());
        }
        assert_eq!(token_1.balance_of(address: test.privacy.address), amount.into() * 2);
    } else {
        assert_eq!(token_1.balance_of(address: *depositor.address), Zero::zero());
        assert_eq!(token_2.balance_of(address: *depositor.address), Zero::zero());
        assert_eq!(token_3.balance_of(address: *depositor.address), amount.into());
        if !self_deposit {
            assert_eq!(token_1.balance_of(address: recipient.address), Zero::zero());
            assert_eq!(token_2.balance_of(address: recipient.address), Zero::zero());
            assert_eq!(token_3.balance_of(address: recipient.address), Zero::zero());
        }
        assert_eq!(token_1.balance_of(address: test.privacy.address), amount.into());
        assert_eq!(token_2.balance_of(address: test.privacy.address), amount.into());
        assert_eq!(token_3.balance_of(address: test.privacy.address), Zero::zero());
    }

    depositor.deposit_flow(ref :recipient, token: token_3, :amount);

    if same_token {
        assert_eq!(token_1.balance_of(address: *depositor.address), Zero::zero());
        if !self_deposit {
            assert_eq!(token_1.balance_of(address: recipient.address), Zero::zero());
        }
        assert_eq!(token_1.balance_of(address: test.privacy.address), amount.into() * 3);
    } else {
        assert_eq!(token_1.balance_of(address: *depositor.address), Zero::zero());
        assert_eq!(token_2.balance_of(address: *depositor.address), Zero::zero());
        assert_eq!(token_3.balance_of(address: *depositor.address), Zero::zero());
        if !self_deposit {
            assert_eq!(token_1.balance_of(address: recipient.address), Zero::zero());
            assert_eq!(token_2.balance_of(address: recipient.address), Zero::zero());
            assert_eq!(token_3.balance_of(address: recipient.address), Zero::zero());
        }
        assert_eq!(token_1.balance_of(address: test.privacy.address), amount.into());
        assert_eq!(token_2.balance_of(address: test.privacy.address), amount.into());
        assert_eq!(token_3.balance_of(address: test.privacy.address), amount.into());
    }
}

#[test]
fn test_deposit_withdraw_different_tx_flow() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let amount = constants::DEFAULT_AMOUNT;
    token.supply(address: user.address, :amount);

    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    let note_index = user.deposit_flow(ref recipient: user, :token, :amount);

    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    let _ = user
        .withdraw_flow(sender: @user, withdrawal_target: @user, :token, :note_index, :amount);

    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
}

#[test]
fn test_deposit_withdraw_same_tx_flow() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let amount = constants::DEFAULT_AMOUNT;
    let self_channel_id = user.compute_channel_id(recipient: @user);
    let self_subchannel_id = user
        .compute_subchannel_id(recipient: @user, token_address: token.contract_address());
    token.supply(address: user.address, :amount);
    user.approve(:token, amount: amount.into());

    let mut client_actions = array![];
    client_actions.append(user.deposit_action(:token, :amount));
    client_actions.append(user.withdraw_action(withdrawal_target: user.address, :token, :amount));

    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
    assert!(!user.privacy.channel_exists(channel_id: self_channel_id));
    assert!(!user.privacy.subchannel_exists(subchannel_id: self_subchannel_id));

    user.compile_and_execute(client_actions: client_actions.span());

    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
    assert!(!user.privacy.channel_exists(channel_id: self_channel_id));
    assert!(!user.privacy.subchannel_exists(subchannel_id: self_subchannel_id));
}

#[test]
fn test_deposit_transfer_withdraw_flow() {
    let mut test: Test = Default::default();
    let mut sender = test.new_user();
    let mut recipient = test.new_user();
    let token = test.new_token();
    let amount = constants::DEFAULT_AMOUNT;
    token.supply(address: sender.address, :amount);

    assert_eq!(token.balance_of(address: sender.address), amount.into());
    assert_eq!(token.balance_of(address: recipient.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    let deposit_note_index = sender.deposit_flow(ref recipient: sender, :token, :amount);

    assert_eq!(token.balance_of(address: sender.address), Zero::zero());
    assert_eq!(token.balance_of(address: recipient.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    let (transfer_note_index, _) = sender
        .simple_transfer_flow(
            sender: @sender, ref :recipient, :token, note_index: deposit_note_index, :amount,
        );

    assert_eq!(token.balance_of(address: sender.address), Zero::zero());
    assert_eq!(token.balance_of(address: recipient.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    let _ = recipient
        .withdraw_flow(
            sender: @sender,
            withdrawal_target: @recipient,
            :token,
            note_index: transfer_note_index,
            :amount,
        );

    assert_eq!(token.balance_of(address: sender.address), Zero::zero());
    assert_eq!(token.balance_of(address: recipient.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
}

#[test]
fn test_deposit_self_transfer_withdraw_deposit_again_flow() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let amount = constants::DEFAULT_AMOUNT;
    token.supply(address: user.address, :amount);

    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    let deposit_note_index = user.deposit_flow(ref recipient: user, :token, :amount);

    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    let mut client_actions = array![];
    client_actions
        .append(user.use_note_action(sender: @user, :token, note_index: deposit_note_index));
    let (create_note_actions, transfer_note_index) = user
        .create_note_actions(ref recipient: user, :token, :amount);
    client_actions.append_span(create_note_actions);
    user.compile_and_execute(client_actions: client_actions.span());

    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    let _ = user
        .withdraw_flow(
            sender: @user,
            withdrawal_target: @user,
            :token,
            note_index: transfer_note_index,
            :amount,
        );

    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    user.deposit_flow(ref recipient: user, :token, :amount);

    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
}

#[test]
#[test_case(false, false)]
#[test_case(false, true)]
#[test_case(true, false)]
#[test_case(true, true)]
fn test_deposit_withdraw_flow(deposit_multiple_notes: bool, transfer_to_others: bool) {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let token = test.new_token();
    let amount = constants::DEFAULT_AMOUNT;
    token.supply(address: user_1.address, amount: amount * 10);

    assert_eq!(token.balance_of(address: user_1.address), amount.into() * 10);
    if transfer_to_others {
        assert_eq!(token.balance_of(address: user_2.address), Zero::zero());
        assert_eq!(token.balance_of(address: user_3.address), Zero::zero());
    }
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    let transfer_note_index = if !deposit_multiple_notes {
        let deposit_note_index = user_1
            .deposit_flow(ref recipient: user_1, :token, amount: amount * 9);

        assert_eq!(token.balance_of(address: user_1.address), amount.into());
        if transfer_to_others {
            assert_eq!(token.balance_of(address: user_2.address), Zero::zero());
            assert_eq!(token.balance_of(address: user_3.address), Zero::zero());
        }
        assert_eq!(token.balance_of(address: test.privacy.address), amount.into() * 9);

        deposit_note_index
    } else {
        let deposit_note_index_1 = user_1
            .deposit_flow(ref recipient: user_1, :token, amount: amount * 5);
        let deposit_note_index_2 = user_1
            .deposit_flow(ref recipient: user_1, :token, amount: amount * 3);
        let deposit_note_index_3 = user_1
            .deposit_flow(ref recipient: user_1, :token, amount: amount);

        assert_eq!(token.balance_of(address: user_1.address), amount.into());
        if transfer_to_others {
            assert_eq!(token.balance_of(address: user_2.address), Zero::zero());
            assert_eq!(token.balance_of(address: user_3.address), Zero::zero());
        }
        assert_eq!(token.balance_of(address: test.privacy.address), amount.into() * 9);

        let mut merge_actions = array![];
        merge_actions
            .append(
                user_1.use_note_action(sender: @user_1, :token, note_index: deposit_note_index_1),
            );
        merge_actions
            .append(
                user_1.use_note_action(sender: @user_1, :token, note_index: deposit_note_index_2),
            );
        merge_actions
            .append(
                user_1.use_note_action(sender: @user_1, :token, note_index: deposit_note_index_3),
            );
        let (create_note_actions, merge_note_index) = user_1
            .create_note_actions(ref recipient: user_1, :token, amount: amount * 9);
        merge_actions.append_span(create_note_actions);
        user_1.compile_and_execute(client_actions: merge_actions.span());

        assert_eq!(token.balance_of(address: user_1.address), amount.into());
        if transfer_to_others {
            assert_eq!(token.balance_of(address: user_2.address), Zero::zero());
            assert_eq!(token.balance_of(address: user_3.address), Zero::zero());
        }
        assert_eq!(token.balance_of(address: test.privacy.address), amount.into() * 9);

        merge_note_index
    };

    if !transfer_to_others {
        let _ = user_1
            .withdraw_flow(
                sender: @user_1,
                withdrawal_target: @user_1,
                :token,
                note_index: transfer_note_index,
                amount: amount * 9,
            );

        assert_eq!(token.balance_of(address: user_1.address), amount.into() * 10);
        assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
    } else {
        user_2.set_viewing_key_e2e();
        user_3.set_viewing_key_e2e();

        let mut transfer_actions = array![];
        transfer_actions
            .append(
                user_1.use_note_action(sender: @user_1, :token, note_index: transfer_note_index),
            );
        let (user_1_create_note_actions, user_1_note_index) = user_1
            .create_note_actions(ref recipient: user_1, :token, :amount);
        transfer_actions.append_span(user_1_create_note_actions);
        let (user_2_create_note_actions, user_2_note_index) = user_1
            .create_note_actions(ref recipient: user_2, :token, amount: amount * 5);
        transfer_actions.append_span(user_2_create_note_actions);
        let (user_3_create_note_actions, user_3_note_index) = user_1
            .create_note_actions(ref recipient: user_3, :token, amount: amount * 3);
        transfer_actions.append_span(user_3_create_note_actions);
        user_1.compile_and_execute(client_actions: transfer_actions.span());

        assert_eq!(token.balance_of(address: user_1.address), amount.into());
        assert_eq!(token.balance_of(address: user_2.address), Zero::zero());
        assert_eq!(token.balance_of(address: user_3.address), Zero::zero());
        assert_eq!(token.balance_of(address: test.privacy.address), amount.into() * 9);

        let _ = user_1
            .withdraw_flow(
                sender: @user_1,
                withdrawal_target: @user_1,
                :token,
                note_index: user_1_note_index,
                :amount,
            );

        assert_eq!(token.balance_of(address: user_1.address), amount.into() * 2);
        assert_eq!(token.balance_of(address: user_2.address), Zero::zero());
        assert_eq!(token.balance_of(address: user_3.address), Zero::zero());
        assert_eq!(token.balance_of(address: test.privacy.address), amount.into() * 8);

        let _ = user_2
            .withdraw_flow(
                sender: @user_1,
                withdrawal_target: @user_2,
                :token,
                note_index: user_2_note_index,
                amount: amount * 5,
            );

        assert_eq!(token.balance_of(address: user_1.address), amount.into() * 2);
        assert_eq!(token.balance_of(address: user_2.address), amount.into() * 5);
        assert_eq!(token.balance_of(address: user_3.address), Zero::zero());
        assert_eq!(token.balance_of(address: test.privacy.address), amount.into() * 3);

        let _ = user_3
            .withdraw_flow(
                sender: @user_1,
                withdrawal_target: @user_3,
                :token,
                note_index: user_3_note_index,
                amount: amount * 3,
            );

        assert_eq!(token.balance_of(address: user_1.address), amount.into() * 2);
        assert_eq!(token.balance_of(address: user_2.address), amount.into() * 5);
        assert_eq!(token.balance_of(address: user_3.address), amount.into() * 3);
        assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
    }
}

#[test]
fn test_deposit_multiple_notes_transfer_to_other_withdraw_flow() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let amount = constants::DEFAULT_AMOUNT;
    token.supply(address: user_1.address, amount: amount * 10);

    assert_eq!(token.balance_of(address: user_1.address), amount.into() * 10);
    assert_eq!(token.balance_of(address: user_2.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    let deposit_note_index_1 = user_1
        .deposit_flow(ref recipient: user_1, :token, amount: amount * 5);
    let deposit_note_index_2 = user_1
        .deposit_flow(ref recipient: user_1, :token, amount: amount * 3);
    let deposit_note_index_3 = user_1.deposit_flow(ref recipient: user_1, :token, :amount);

    assert_eq!(token.balance_of(address: user_1.address), amount.into());
    assert_eq!(token.balance_of(address: user_2.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into() * 9);

    user_2.set_viewing_key_e2e();
    let mut merge_actions = array![];
    merge_actions
        .append(user_1.use_note_action(sender: @user_1, :token, note_index: deposit_note_index_1));
    merge_actions
        .append(user_1.use_note_action(sender: @user_1, :token, note_index: deposit_note_index_2));
    merge_actions
        .append(user_1.use_note_action(sender: @user_1, :token, note_index: deposit_note_index_3));
    let (create_note_actions, merge_note_index) = user_1
        .create_note_actions(ref recipient: user_2, :token, amount: amount * 9);
    merge_actions.append_span(create_note_actions);
    user_1.compile_and_execute(client_actions: merge_actions.span());

    assert_eq!(token.balance_of(address: user_1.address), amount.into());
    assert_eq!(token.balance_of(address: user_2.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into() * 9);

    let _ = user_2
        .withdraw_flow(
            sender: @user_1,
            withdrawal_target: @user_2,
            :token,
            note_index: merge_note_index,
            amount: amount * 9,
        );

    assert_eq!(token.balance_of(address: user_1.address), amount.into());
    assert_eq!(token.balance_of(address: user_2.address), amount.into() * 9);
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
}

#[test]
fn test_deposit_same_token_same_amount_twice_flow() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let amount = constants::DEFAULT_AMOUNT;
    token.supply(address: user.address, amount: amount * 2);

    assert_eq!(token.balance_of(address: user.address), amount.into() * 2);
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    let deposit_note_index_1 = user.deposit_flow(ref recipient: user, :token, :amount);
    let deposit_note_index_2 = user.deposit_flow(ref recipient: user, :token, :amount);

    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into() * 2);

    let channel_key = user.compute_channel_key(recipient: @user);
    let note_id_1 = compute_note_id(
        :channel_key, token: token.contract_address(), index: deposit_note_index_1,
    );
    let note_id_2 = compute_note_id(
        :channel_key, token: token.contract_address(), index: deposit_note_index_2,
    );
    assert_ne!(note_id_1, note_id_2);

    let note_1_enc_value = test.privacy.get_note(note_id: note_id_1);
    let note_2_enc_value = test.privacy.get_note(note_id: note_id_2);
    assert_ne!(note_1_enc_value, note_2_enc_value);
}
