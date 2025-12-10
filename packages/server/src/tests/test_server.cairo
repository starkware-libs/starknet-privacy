use core::num::traits::Zero;
use server::errors;
use server::objects::EncChannelInfo;
use server::tests::test_utils::{ServerCfgTrait, deploy_server};
use starknet::ContractAddress;
use starkware_utils_testing::test_utils::assert_panic_with_felt_error;

#[test]
fn test_open_channel() {
    let server = deploy_server();
    let recipient_addr: ContractAddress = 'RECIPIENT_ADDRESS'.try_into().unwrap();
    let enc_channel_info = EncChannelInfo {
        ephemeral_pubkey: 'EPHEMERAL_PUBKEY'.try_into().unwrap(),
        enc_channel_key: 'ENC_CHANNEL_KEY'.try_into().unwrap(),
        enc_token: 'ENC_TOKEN'.try_into().unwrap(),
        enc_sender_addr: 'ENC_SENDER_ADDR'.try_into().unwrap(),
    };
    let channel_hash = 'CHANNEL_HASH'.try_into().unwrap();
    server.open_channel(:recipient_addr, :enc_channel_info, :channel_hash);
    assert_eq!(server.read_channel_hashes(key: channel_hash), true);
    assert_eq!(server.read_channels_length(:recipient_addr), 1);
    assert_eq!(server.read_channels_at(:recipient_addr, index: 0), enc_channel_info);
}

#[test]
fn test_open_channel_twice() {
    let server = deploy_server();
    let recipient_addr: ContractAddress = 'RECIPIENT_ADDRESS'.try_into().unwrap();
    // Open first channel.
    let mut nonce = 0;
    let enc_channel_info_1 = EncChannelInfo {
        ephemeral_pubkey: ('EPHEMERAL_PUBKEY' + nonce.into()).try_into().unwrap(),
        enc_channel_key: ('ENC_CHANNEL_KEY' + nonce.into()).try_into().unwrap(),
        enc_token: ('ENC_TOKEN' + nonce.into()).try_into().unwrap(),
        enc_sender_addr: ('ENC_SENDER_ADDR' + nonce.into()).try_into().unwrap(),
    };
    let channel_hash_1 = ('CHANNEL_HASH' + nonce.into()).try_into().unwrap();
    server
        .open_channel(
            :recipient_addr, enc_channel_info: enc_channel_info_1, channel_hash: channel_hash_1,
        );
    // Open second channel.
    nonce += 1;
    let enc_channel_info_2 = EncChannelInfo {
        ephemeral_pubkey: ('EPHEMERAL_PUBKEY' + nonce.into()).try_into().unwrap(),
        enc_channel_key: ('ENC_CHANNEL_KEY' + nonce.into()).try_into().unwrap(),
        enc_token: ('ENC_TOKEN' + nonce.into()).try_into().unwrap(),
        enc_sender_addr: ('ENC_SENDER_ADDR' + nonce.into()).try_into().unwrap(),
    };
    let channel_hash_2 = ('CHANNEL_HASH' + nonce.into()).try_into().unwrap();
    server
        .open_channel(
            :recipient_addr, enc_channel_info: enc_channel_info_2, channel_hash: channel_hash_2,
        );

    assert_eq!(server.read_channel_hashes(key: channel_hash_1), true);
    assert_eq!(server.read_channel_hashes(key: channel_hash_2), true);
    assert_eq!(server.read_channels_length(:recipient_addr), 2);
    assert_eq!(server.read_channels_at(:recipient_addr, index: 0), enc_channel_info_1);
    assert_eq!(server.read_channels_at(:recipient_addr, index: 1), enc_channel_info_2);
}

#[test]
fn test_open_channel_assertions() {
    let server = deploy_server();
    let mut recipient_addr: ContractAddress = 'RECIPIENT_ADDRESS'.try_into().unwrap();
    let mut enc_channel_info = EncChannelInfo {
        ephemeral_pubkey: 'EPHEMERAL_PUBKEY'.try_into().unwrap(),
        enc_channel_key: 'ENC_CHANNEL_KEY'.try_into().unwrap(),
        enc_token: 'ENC_TOKEN'.try_into().unwrap(),
        enc_sender_addr: 'ENC_SENDER_ADDR'.try_into().unwrap(),
    };
    let mut channel_hash = 'CHANNEL_HASH'.try_into().unwrap();

    // Catch ZERO_RECIPIENT_ADDR.
    let result = server
        .safe_open_channel(recipient_addr: Zero::zero(), :enc_channel_info, :channel_hash);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_ENC_CHANNEL_INFO (ephemeral_pubkey).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.ephemeral_pubkey = Zero::zero();
    let result = server
        .safe_open_channel(:recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_hash);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_ENC_CHANNEL_INFO (enc_channel_key).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.enc_channel_key = Zero::zero();
    let result = server
        .safe_open_channel(:recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_hash);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_ENC_CHANNEL_INFO (enc_token).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.enc_token = Zero::zero();
    let result = server
        .safe_open_channel(:recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_hash);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_ENC_CHANNEL_INFO (enc_sender_addr).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.enc_sender_addr = Zero::zero();
    let result = server
        .safe_open_channel(:recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_hash);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_CHANNEL_HASH.
    let result = server
        .safe_open_channel(:recipient_addr, :enc_channel_info, channel_hash: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_CHANNEL_HASH);

    // Catch CHANNEL_ALREADY_EXISTS.
    server.open_channel(:recipient_addr, :enc_channel_info, :channel_hash);
    let result = server.safe_open_channel(:recipient_addr, :enc_channel_info, :channel_hash);
    assert_panic_with_felt_error(:result, expected_error: errors::CHANNEL_ALREADY_EXISTS);
}
