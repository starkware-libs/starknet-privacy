use privacy::errors;
use privacy::tests::utils_for_tests::{PrivacyCfgTrait, Test, TestTrait, UserFlowTrait, UserTrait};
use starkware_utils_testing::test_utils::assert_panic_with_felt_error;

// Open Channel Flows
#[test]
fn test_open_channel_flow() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let channel_id = user_1.compute_channel_id(recipient: user_2);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 0);
    assert!(!test.privacy.channel_exists(:channel_id));

    user_1.open_channel_flow(ref recipient: user_2);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 1);
    assert!(test.privacy.channel_exists(:channel_id));
}

#[test]
fn test_open_self_channel_flow() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let channel_id = user.compute_channel_id(recipient: user);

    assert_eq!(user.get_num_of_channels(), 0);
    assert!(!test.privacy.channel_exists(:channel_id));

    user.open_channel_flow(ref recipient: user);

    assert_eq!(user.get_num_of_channels(), 1);
    assert!(test.privacy.channel_exists(:channel_id));
}

#[test]
fn test_open_2_channels_in_succession_flow() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let channel_id_1_to_2 = user_1.compute_channel_id(recipient: user_2);
    let channel_id_1_to_3 = user_1.compute_channel_id(recipient: user_3);

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
    let channel_id = user_1.compute_channel_id(recipient: user_2);
    let random = user_1.get_random().into();
    let open_channel_actions = user_1.open_channel(recipient: user_2, :random);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 0);
    assert!(!test.privacy.channel_exists(:channel_id));

    test.privacy.execute_actions(actions: open_channel_actions);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 1);
    assert!(test.privacy.channel_exists(:channel_id));

    let result = user_1.safe_open_channel(recipient: user_2, :random);
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
    let channel_id = user_1.compute_channel_id(recipient: user_2);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 0);
    assert!(!test.privacy.channel_exists(:channel_id));

    let result = user_1.safe_open_channel(recipient: user_2, random: user_1.get_random().into());
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
    let channel_id_old_key = user_1.compute_channel_id(recipient: user_2);
    user_1.new_key();
    let channel_id_new_key = user_1.compute_channel_id(recipient: user_2);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 0);
    assert!(!test.privacy.channel_exists(channel_id: channel_id_old_key));
    assert!(!test.privacy.channel_exists(channel_id: channel_id_new_key));

    let result = user_1.safe_open_channel(recipient: user_2, random: user_1.get_random().into());
    assert_panic_with_felt_error(:result, expected_error: errors::SENDER_NOT_AUTHENTICATED);

    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(user_2.get_num_of_channels(), 0);
    assert!(!test.privacy.channel_exists(channel_id: channel_id_old_key));
    assert!(!test.privacy.channel_exists(channel_id: channel_id_new_key));
}
