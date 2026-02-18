use core::num::traits::Zero;
use privacy::actions::{ServerAction, WriteOnceInput};
use privacy::hashes::hash;
use privacy::tests::utils_for_tests::{
    decrypt_channel_info, decrypt_enc_user_addr, decrypt_private_key, decrypt_subchannel_token,
};
use privacy::utils::constants::{OPEN_NOTE_SALT, TWO_POW_120};
use privacy::utils::{
    _encrypt_note_amount, decode_note_amount, decrypt_note_amount, derive_public_key,
    enc_note_packed_value, encrypt_channel_info, encrypt_private_key, encrypt_subchannel_info,
    encrypt_user_addr, open_note, packing, to_write_once_action, unpacking,
};
use snforge_std::map_entry_address;
use starknet::ContractAddress;
use starkware_utils::constants::{MAX_U128, MAX_U32, TWO_POW_128};

#[test]
fn test_encrypt_private_key_decrypt() {
    let private_key = hash(['PRIVATE_KEY'].span());
    let random = hash(['RANDOM'].span());
    let auditor_private_key = hash(['AUDITOR_PRIVATE_KEY'].span());
    let auditor_public_key = derive_public_key(private_key: auditor_private_key);
    let enc_private_key = encrypt_private_key(
        ephemeral_secret: random, :auditor_public_key, :private_key,
    );
    let dec_private_key = decrypt_private_key(:enc_private_key, :auditor_private_key);
    assert_eq!(dec_private_key, private_key);
}

#[test]
fn test_encrypt_user_addr_decrypt() {
    let user_addr = hash(['USER_ADDR'].span()).try_into().unwrap();
    let random = hash(['RANDOM'].span());
    let auditor_private_key = hash(['AUDITOR_PRIVATE_KEY'].span());
    let auditor_public_key = derive_public_key(private_key: auditor_private_key);
    let enc_user_addr = encrypt_user_addr(
        ephemeral_secret: random, :auditor_public_key, :user_addr,
    );
    let dec_user_addr = decrypt_enc_user_addr(:enc_user_addr, :auditor_private_key);
    assert_eq!(dec_user_addr, user_addr);
}

#[test]
fn test_encrypt_channel_info_decrypt() {
    let channel_key = hash(['CHANNEL_KEY'].span());
    let sender_addr = hash(['SENDER_ADDR'].span()).try_into().unwrap();
    let random = hash(['RANDOM'].span());
    let recipient_private_key = hash(['RECIPIENT_PRIVATE_KEY'].span());
    let recipient_public_key = derive_public_key(private_key: recipient_private_key);
    let enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random, :recipient_public_key, :channel_key, :sender_addr,
    );
    let (dec_channel_key, dec_sender_addr) = decrypt_channel_info(
        :enc_channel_info, :recipient_private_key,
    );
    assert_eq!(dec_channel_key, channel_key);
    assert_eq!(dec_sender_addr, sender_addr);
}

#[test]
fn test_encrypt_subchannel_info_decrypt() {
    let channel_key = hash(['CHANNEL_KEY'].span());
    let index_u256: u256 = hash(['INDEX'].span()).into();
    let index: usize = (index_u256 % MAX_U32.into()).try_into().unwrap();
    let token = hash(['TOKEN'].span()).try_into().unwrap();
    let salt = hash(['SALT'].span());
    let enc_subchannel_info = encrypt_subchannel_info(:channel_key, :index, :token, :salt);
    let dec_token = decrypt_subchannel_token(:enc_subchannel_info, :channel_key, :index);
    assert_eq!(dec_token, token);
}

#[test]
fn test_encrypt_decrypt_note_amount() {
    let amounts = [1, 123456789, MAX_U128];
    let mut nonce = 0;
    for amount in amounts.span() {
        nonce += 1;
        let channel_key = hash(['CHANNEL_KEY', nonce.into()].span());
        nonce += 1;
        let salt_120_bits_u256: u256 = hash(['SALT', nonce.into()].span())
            .into() % TWO_POW_120
            .into();
        let salt_120_bits: u128 = salt_120_bits_u256.try_into().unwrap();
        nonce += 1;
        let token: ContractAddress = hash(['TOKEN', nonce.into()].span()).try_into().unwrap();
        nonce += 1;
        let index_u256: u256 = hash(['INDEX', nonce.into()].span()).into();
        let index: usize = (index_u256 % MAX_U32.into()).try_into().unwrap();
        let enc_amount = _encrypt_note_amount(
            :channel_key, :token, :index, salt: salt_120_bits, amount: *amount,
        );
        let dec_amount = decrypt_note_amount(
            :enc_amount, salt: salt_120_bits, :channel_key, :token, :index,
        );
        assert_eq!(dec_amount, *amount);
    }
}

#[test]
fn test_enc_note_packed_value_decode_note_amount() {
    let amounts = [1, 123456789, MAX_U128];
    let mut nonce = 0;
    for amount in amounts.span() {
        nonce += 1;
        let channel_key = hash(['CHANNEL_KEY', nonce.into()].span());
        nonce += 1;
        let salt_120_bits_u256: u256 = hash(['SALT', nonce.into()].span())
            .into() % TWO_POW_120
            .into();
        let salt_120_bits: u128 = salt_120_bits_u256.try_into().unwrap();
        nonce += 1;
        let token: ContractAddress = hash(['TOKEN', nonce.into()].span()).try_into().unwrap();
        nonce += 1;
        let index_u256: u256 = hash(['INDEX', nonce.into()].span()).into();
        let index: usize = (index_u256 % MAX_U32.into()).try_into().unwrap();
        let packed_value = enc_note_packed_value(
            :channel_key, :token, :index, salt: salt_120_bits, amount: *amount,
        );
        let dec_amount = decode_note_amount(:packed_value, :channel_key, :token, :index);
        assert_eq!(dec_amount, *amount);
    }
}

#[test]
fn test_open_note_packed_value_decode_note_amount() {
    let amounts = [1, 123456789, MAX_U128];
    let mut nonce = 0;
    for amount in amounts.span() {
        nonce += 1;
        let token: ContractAddress = hash(['TOKEN', nonce.into()].span()).try_into().unwrap();
        nonce += 1;
        let depositor: ContractAddress = hash(['DEPOSITOR', nonce.into()].span())
            .try_into()
            .unwrap();
        let note = open_note(:token, :depositor);
        let dec_amount = decode_note_amount(
            packed_value: note.packed_value, channel_key: Zero::zero(), :token, index: Zero::zero(),
        );
        assert_eq!(dec_amount, Zero::zero());
        let packed_value_with_amount = packing(value_1: OPEN_NOTE_SALT, value_2: *amount);
        let dec_amount_with_amount = decode_note_amount(
            packed_value: packed_value_with_amount,
            channel_key: Zero::zero(),
            :token,
            index: Zero::zero(),
        );
        assert_eq!(dec_amount_with_amount, *amount);
    }
}

#[test]
fn test_open_note() {
    let token = 'TOKEN'.try_into().unwrap();
    let depositor = 'DEPOSITOR'.try_into().unwrap();
    let note = open_note(:token, :depositor);
    let (salt, amount) = unpacking(note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(amount, 0);
    assert_eq!(note.token, token);
    assert_eq!(note.depositor, depositor);
}

#[test]
fn test_packing_unpacking() {
    let max_120_bits: u128 = TWO_POW_120.try_into().unwrap() - 1;
    let max_u128: u128 = (TWO_POW_128 - 1).try_into().unwrap();
    let values: [(u128, u128); 4] = [
        (1, 1), (1, max_u128), (max_120_bits, 1), (max_120_bits, max_u128),
    ];
    for (value_1, value_2) in values.span() {
        let packed_value = packing(value_1: (*value_1).into(), value_2: *value_2);
        let (unpacked_value_1, unpacked_value_2) = unpacking(:packed_value);
        assert_eq!(unpacked_value_1, *value_1);
        assert_eq!(unpacked_value_2, *value_2);
    }
}

#[test]
fn test_packing_unpacking_random() {
    let mut nonce = 0;
    for _ in 0..100_u32 {
        nonce += 1;
        let value_1_120_bits_u256: u256 = hash(['VALUE_1', nonce.into()].span())
            .into() % TWO_POW_120
            .into();
        let value_1_120_bits: u128 = value_1_120_bits_u256.try_into().unwrap();
        nonce += 1;
        let value_2_128_bits: u128 = (hash(['VALUE_2', nonce.into()].span()).into() % TWO_POW_128)
            .try_into()
            .unwrap();
        let packed_value = packing(value_1: value_1_120_bits, value_2: value_2_128_bits);
        let (unpacked_value_1, unpacked_value_2) = unpacking(:packed_value);
        assert_eq!(unpacked_value_1, value_1_120_bits);
        assert_eq!(unpacked_value_2, value_2_128_bits);
    }
}

#[test]
fn test_decode_note_amount_open_note() {
    let amounts = [1_u128, 123456789, MAX_U128];
    let channel_key = hash(['CHANNEL_KEY'].span());
    let token: ContractAddress = hash(['TOKEN'].span()).try_into().unwrap();
    let index: usize = 0;
    for amount in amounts.span() {
        let packed_value = packing(value_1: OPEN_NOTE_SALT, value_2: *amount);
        let decoded_amount = decode_note_amount(:packed_value, :channel_key, :token, :index);
        assert_eq!(decoded_amount, *amount);
    }
}

#[test]
fn test_decode_note_amount_open_note_empty() {
    let channel_key = hash(['CHANNEL_KEY'].span());
    let token: ContractAddress = hash(['TOKEN'].span()).try_into().unwrap();
    let index: usize = 0;
    let packed_value = packing(value_1: OPEN_NOTE_SALT, value_2: 0);
    decode_note_amount(:packed_value, :channel_key, :token, :index);
}

#[test]
fn test_to_write_once_action_felt() {
    let value = 'VALUE';
    let key = 'KEY';
    let storage_address = map_entry_address(map_selector: selector!("value"), keys: [key].span());
    let action = to_write_once_action(:storage_address, :value);
    assert_eq!(
        action, ServerAction::WriteOnce(WriteOnceInput { storage_address, value: [value].span() }),
    );
}
