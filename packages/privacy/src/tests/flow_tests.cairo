use privacy::errors;
use privacy::tests::utils_for_tests::{PrivacyCfgTrait, Test, TestTrait, UserFlowTrait, UserTrait};
use snforge_std::TokenTrait;
use starkware_utils_testing::test_utils::assert_panic_with_felt_error;

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
