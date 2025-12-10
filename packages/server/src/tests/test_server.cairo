use core::num::traits::Zero;
use server::errors;
use server::objects::EncChannel;
use server::tests::test_utils::{ServerCfgTrait, deploy_server};
use starknet::ContractAddress;
use starkware_utils_testing::test_utils::assert_panic_with_felt_error;

#[test]
fn test_create_channel() {
    let server = deploy_server();
    let recipient_addr: ContractAddress = 'RECIPIENT_ADDRESS'.try_into().unwrap();
    let enc_channel_info = EncChannel {
        ephemeral_pubkey: 'EPHEMERAL_PUBKEY'.try_into().unwrap(),
        enc_channel_key: 'ENC_CHANNEL_KEY'.try_into().unwrap(),
        enc_token: 'ENC_TOKEN'.try_into().unwrap(),
        enc_sender_addr: 'ENC_SENDER_ADDR'.try_into().unwrap(),
    };
    let channel_hash = 'CHANNEL_HASH'.try_into().unwrap();
    server.create_channel(:recipient_addr, :enc_channel_info, :channel_hash);
    assert_eq!(server.read_channel_hashes(key: channel_hash), true);
    assert_eq!(server.read_channels_length(:recipient_addr), 1);
    assert_eq!(server.read_channels_at(:recipient_addr, index: 0), enc_channel_info);
}

#[test]
fn test_create_channel_twice() {
    let server = deploy_server();
    let recipient_addr: ContractAddress = 'RECIPIENT_ADDRESS'.try_into().unwrap();
    let mut nonce = 0;
    let enc_channel_info_1 = EncChannel {
        ephemeral_pubkey: ('EPHEMERAL_PUBKEY' + nonce.into()).try_into().unwrap(),
        enc_channel_key: ('ENC_CHANNEL_KEY' + nonce.into()).try_into().unwrap(),
        enc_token: ('ENC_TOKEN' + nonce.into()).try_into().unwrap(),
        enc_sender_addr: ('ENC_SENDER_ADDR' + nonce.into()).try_into().unwrap(),
    };
    let channel_hash_1 = ('CHANNEL_HASH' + nonce.into()).try_into().unwrap();
    nonce += 1;
    server
        .create_channel(
            :recipient_addr, enc_channel_info: enc_channel_info_1, channel_hash: channel_hash_1,
        );
    let enc_channel_info_2 = EncChannel {
        ephemeral_pubkey: ('EPHEMERAL_PUBKEY' + nonce.into()).try_into().unwrap(),
        enc_channel_key: ('ENC_CHANNEL_KEY' + nonce.into()).try_into().unwrap(),
        enc_token: ('ENC_TOKEN' + nonce.into()).try_into().unwrap(),
        enc_sender_addr: ('ENC_SENDER_ADDR' + nonce.into()).try_into().unwrap(),
    };
    let channel_hash_2 = ('CHANNEL_HASH' + nonce.into()).try_into().unwrap();
    server
        .create_channel(
            :recipient_addr, enc_channel_info: enc_channel_info_2, channel_hash: channel_hash_2,
        );

    assert_eq!(server.read_channel_hashes(key: channel_hash_1), true);
    assert_eq!(server.read_channel_hashes(key: channel_hash_2), true);
    assert_eq!(server.read_channels_length(:recipient_addr), 2);
    assert_eq!(server.read_channels_at(:recipient_addr, index: 0), enc_channel_info_1);
    assert_eq!(server.read_channels_at(:recipient_addr, index: 1), enc_channel_info_2);
}

#[test]
fn test_create_channel_assertions() {
    let server = deploy_server();
    let mut recipient_addr: ContractAddress = 'RECIPIENT_ADDRESS'.try_into().unwrap();
    let mut enc_channel_info = EncChannel {
        ephemeral_pubkey: 'EPHEMERAL_PUBKEY'.try_into().unwrap(),
        enc_channel_key: 'ENC_CHANNEL_KEY'.try_into().unwrap(),
        enc_token: 'ENC_TOKEN'.try_into().unwrap(),
        enc_sender_addr: 'ENC_SENDER_ADDR'.try_into().unwrap(),
    };
    let mut channel_hash = 'CHANNEL_HASH'.try_into().unwrap();

    // Catch ZERO_RECIPIENT_ADDR.
    let result = server
        .safe_create_channel(recipient_addr: Zero::zero(), :enc_channel_info, :channel_hash);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_ENC_CHANNEL_INFO (ephemeral_pubkey).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.ephemeral_pubkey = Zero::zero();
    let result = server
        .safe_create_channel(
            :recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_hash,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_ENC_CHANNEL_INFO (enc_channel_key).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.enc_channel_key = Zero::zero();
    let result = server
        .safe_create_channel(
            :recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_hash,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_ENC_CHANNEL_INFO (enc_token).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.enc_token = Zero::zero();
    let result = server
        .safe_create_channel(
            :recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_hash,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_ENC_CHANNEL_INFO (enc_sender_addr).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.enc_sender_addr = Zero::zero();
    let result = server
        .safe_create_channel(
            :recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_hash,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_CHANNEL_HASH.
    let result = server
        .safe_create_channel(:recipient_addr, :enc_channel_info, channel_hash: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_CHANNEL_HASH);

    // Catch CHANNEL_ALREADY_EXISTS.
    server.create_channel(:recipient_addr, :enc_channel_info, :channel_hash);
    let result = server.safe_create_channel(:recipient_addr, :enc_channel_info, :channel_hash);
    assert_panic_with_felt_error(:result, expected_error: errors::CHANNEL_ALREADY_EXISTS);
}

#[test]
fn test_create_note() {
    let server = deploy_server();
    let note_id = 'NOTE_ID'.try_into().unwrap();
    let enc_note_value = 'ENC_NOTE_VALUE'.try_into().unwrap();
    server.create_note(:note_id, :enc_note_value);
    assert_eq!(server.read_notes(:note_id), enc_note_value);
}

#[test]
fn test_create_note_twice() {
    let server = deploy_server();
    let note_id_1 = 'NOTE_ID'.try_into().unwrap();
    let enc_note_value_1 = 'ENC_NOTE_VALUE'.try_into().unwrap();
    server.create_note(note_id: note_id_1, enc_note_value: enc_note_value_1);
    let note_id_2 = note_id_1 + 1;
    let enc_note_value_2 = enc_note_value_1 + 1;
    server.create_note(note_id: note_id_2, enc_note_value: enc_note_value_2);
    assert_eq!(server.read_notes(note_id: note_id_1), enc_note_value_1);
    assert_eq!(server.read_notes(note_id: note_id_2), enc_note_value_2);
}


// TODO: Figure out how to safely call internal functions.
#[test]
#[should_panic(expected_error: "ZERO_NOTE_ID")]
fn test_create_note_zero_note_id() {
    let server = deploy_server();
    let enc_note_value = 'ENC_NOTE_VALUE'.try_into().unwrap();
    server.create_note(note_id: Zero::zero(), :enc_note_value);
}

#[test]
#[should_panic(expected_error: "ZERO_ENC_NOTE_VALUE")]
fn test_create_note_zero_enc_note_value() {
    let server = deploy_server();
    let note_id = 'NOTE_ID'.try_into().unwrap();
    server.create_note(:note_id, enc_note_value: Zero::zero());
}

#[test]
#[should_panic(expected_error: "NOTE_ALREADY_EXISTS")]
fn test_create_note_note_already_exists() {
    let server = deploy_server();
    let note_id = 'NOTE_ID'.try_into().unwrap();
    let enc_note_value = 'ENC_NOTE_VALUE'.try_into().unwrap();
    server.create_note(:note_id, :enc_note_value);
    let diff_enc_note_value = enc_note_value + 1;
    server.create_note(:note_id, enc_note_value: diff_enc_note_value);
}
