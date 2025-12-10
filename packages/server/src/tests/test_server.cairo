use core::num::traits::Zero;
use server::errors;
use server::tests::test_utils::{ServerCfgTrait, Test, TestTrait, UserTrait};
use starkware_utils_testing::test_utils::{assert_panic_with_error, assert_panic_with_felt_error};

#[test]
fn test_open_channel() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let (enc_channel_info, channel_id) = test.new_channel();
    test.server.open_channel(recipient_addr: user.address, :enc_channel_info, :channel_id);
    assert_eq!(test.server.channel_exists(:channel_id), true);
    assert_eq!(user.get_num_of_channels(), 1);
    assert_eq!(user.get_channel_info(channel_index: 0), enc_channel_info);
}

#[test]
fn test_open_channel_twice() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    // Open first channel.
    let (enc_channel_info_1, channel_id_1) = test.new_channel();
    test
        .server
        .open_channel(
            recipient_addr: user.address,
            enc_channel_info: enc_channel_info_1,
            channel_id: channel_id_1,
        );
    // Open second channel.
    let (enc_channel_info_2, channel_id_2) = test.new_channel();
    test
        .server
        .open_channel(
            recipient_addr: user.address,
            enc_channel_info: enc_channel_info_2,
            channel_id: channel_id_2,
        );

    assert_eq!(test.server.channel_exists(channel_id: channel_id_1), true);
    assert_eq!(test.server.channel_exists(channel_id: channel_id_2), true);
    assert_eq!(user.get_num_of_channels(), 2);
    assert_eq!(user.get_channel_info(channel_index: 0), enc_channel_info_1);
    assert_eq!(user.get_channel_info(channel_index: 1), enc_channel_info_2);
}

#[test]
fn test_open_channel_assertions() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let recipient_addr = user.address;
    let (enc_channel_info, channel_id) = test.new_channel();

    // Catch ZERO_RECIPIENT_ADDR.
    let result = test
        .server
        .safe_open_channel(recipient_addr: Zero::zero(), :enc_channel_info, :channel_id);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_ENC_CHANNEL_INFO (ephemeral_pubkey).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.ephemeral_pubkey = Zero::zero();
    let result = test
        .server
        .safe_open_channel(:recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_id);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_ENC_CHANNEL_INFO (enc_channel_key).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.enc_channel_key = Zero::zero();
    let result = test
        .server
        .safe_open_channel(:recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_id);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_ENC_CHANNEL_INFO (enc_token).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.enc_token = Zero::zero();
    let result = test
        .server
        .safe_open_channel(:recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_id);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_ENC_CHANNEL_INFO (enc_sender_addr).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.enc_sender_addr = Zero::zero();
    let result = test
        .server
        .safe_open_channel(:recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_id);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_CHANNEL_ID.
    let result = test
        .server
        .safe_open_channel(:recipient_addr, :enc_channel_info, channel_id: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_CHANNEL_ID);

    // Catch CHANNEL_ALREADY_EXISTS.
    test.server.open_channel(:recipient_addr, :enc_channel_info, :channel_id);
    let result = test.server.safe_open_channel(:recipient_addr, :enc_channel_info, :channel_id);
    assert_panic_with_felt_error(:result, expected_error: errors::CHANNEL_ALREADY_EXISTS);
}

#[test]
fn test_channel_exists() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let recipient_addr = user.address;
    let (enc_channel_info, channel_id) = test.new_channel();
    assert_eq!(test.server.channel_exists(:channel_id), false);
    test.server.open_channel(:recipient_addr, :enc_channel_info, :channel_id);
    assert_eq!(test.server.channel_exists(:channel_id), true);
    let (_, channel_id) = test.new_channel();
    assert_eq!(test.server.channel_exists(:channel_id), false);
}

#[test]
fn test_get_num_of_channels() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let recipient_addr = user.address;
    // TODO: Test before registeration and after registration.
    assert_eq!(user.get_num_of_channels(), 0);
    let (enc_channel_info, channel_id) = test.new_channel();
    test.server.open_channel(:recipient_addr, :enc_channel_info, :channel_id);
    assert_eq!(user.get_num_of_channels(), 1);
    let (enc_channel_info, channel_id) = test.new_channel();
    test.server.open_channel(:recipient_addr, :enc_channel_info, :channel_id);
    assert_eq!(user.get_num_of_channels(), 2);
    let different_user = test.new_user();
    assert_eq!(different_user.get_num_of_channels(), 0);
}

#[test]
fn test_get_channel_info() {
    let mut test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let (channel_1_user_1, channel_id_1_user_1) = test.new_channel();
    let (channel_2_user_1, channel_id_2_user_1) = test.new_channel();
    let (channel_1_user_2, channel_id_1_user_2) = test.new_channel();
    test
        .server
        .open_channel(
            recipient_addr: user_1.address,
            enc_channel_info: channel_1_user_1,
            channel_id: channel_id_1_user_1,
        );
    test
        .server
        .open_channel(
            recipient_addr: user_1.address,
            enc_channel_info: channel_2_user_1,
            channel_id: channel_id_2_user_1,
        );
    test
        .server
        .open_channel(
            recipient_addr: user_2.address,
            enc_channel_info: channel_1_user_2,
            channel_id: channel_id_1_user_2,
        );

    assert_eq!(user_1.get_channel_info(channel_index: 0), channel_1_user_1);
    assert_eq!(user_1.get_channel_info(channel_index: 1), channel_2_user_1);
    assert_eq!(user_2.get_channel_info(channel_index: 0), channel_1_user_2);
}

#[test]
fn test_get_channel_info_index_out_of_bounds() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let result = user.safe_get_channel_info(channel_index: 0);
    assert_panic_with_error(:result, expected_error: "Index out of bounds");

    let (enc_channel_info, channel_id) = test.new_channel();
    test.server.open_channel(recipient_addr: user.address, :enc_channel_info, :channel_id);

    let result = user.safe_get_channel_info(channel_index: 0);
    assert!(result.is_ok());
    let result = user.safe_get_channel_info(channel_index: 1);
    assert_panic_with_error(:result, expected_error: "Index out of bounds");
}
