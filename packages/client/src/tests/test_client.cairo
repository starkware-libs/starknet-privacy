use client::errors as Errors;
use client::objects::{NewNote, NotePath};
use client::tests::test_utils::{Test, TestTrait, UserTrait, decrypt_channel_info};
use client::utils::{
    compute_channel_id, compute_channel_key, compute_note_id, decrypt_note_amount,
    encrypt_channel_info, encrypt_note_amount, is_canonical_key,
};
use core::num::traits::Zero;
use server::objects::EncNote;
use server::objects::domain_separation::enc_channel_info;
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use starkware_utils_testing::test_utils::{assert_panic_with_felt_error, generic_load};


#[test]
fn test_constructor() {
    let mut test: Test = Default::default();

    let actual_server = generic_load(
        target: test.cfg.address, storage_address: selector!("server"),
    );
    assert_eq!(actual_server, test.cfg.server);
}

#[test]
#[should_panic(expected_error: "ZERO_SERVER")]
fn test_constructor_zero_server() {
    let mut calldata = array![];
    calldata.append(Zero::zero());
    declare(contract: "Client")
        .unwrap()
        .contract_class()
        .deploy(constructor_calldata: @calldata)
        .unwrap();
}

#[test]
fn test_transfer() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_server();
    user_2.register_server();
    let token = test.new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);

    let (nullifiers, new_notes) = user_1
        .transfer(
            notes_to_use: [NotePath { channel_index: 0, note_index: 0 },].span(),
            notes_to_create: [note].span(),
        );

    // Test use_note output.
    let expected_nullifiers = [].span();
    assert_eq!(nullifiers, expected_nullifiers);

    // Test create_note output.
    let channel_key = compute_channel_key(
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        :token,
    );
    let note_id = compute_note_id(:channel_key, index: note_index, public_key: user_2.public_key);
    let enc_amount = encrypt_note_amount(:channel_key, index: note_index, :amount);
    let expected_new_notes = [EncNote { id: note_id, enc_amount }].span();
    assert_eq!(new_notes, expected_new_notes);
}

#[test]
fn test_transfer_to_self() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.register_server();
    let token = test.new_token();
    user.open_channel_e2e(recipient: user, :token);
    let amount = 1;
    let note_index = 0;
    let note = user.new_note(recipient: user, :token, :amount, index: note_index);

    let (nullifiers, new_notes) = user
        .transfer(
            notes_to_use: [NotePath { channel_index: 0, note_index: 0 },].span(),
            notes_to_create: [note].span(),
        );

    // Test use_note output.
    let expected_nullifiers = [].span();
    assert_eq!(nullifiers, expected_nullifiers);

    // Test create_note output.
    let channel_key = compute_channel_key(
        sender_addr: user.address,
        sender_private_key: user.private_key,
        recipient_addr: user.address,
        recipient_public_key: user.public_key,
        :token,
    );
    let note_id = compute_note_id(:channel_key, index: note_index, public_key: user.public_key);
    let enc_amount = encrypt_note_amount(:channel_key, index: note_index, :amount);
    let expected_new_notes = [EncNote { id: note_id, enc_amount }].span();
    assert_eq!(new_notes, expected_new_notes);
}

#[test]
fn test_transfer_one_to_many() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let user_3 = test.new_user();
    user_1.register_server();
    user_2.register_server();
    user_3.register_server();
    let token = test.new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    user_1.open_channel_e2e(recipient: user_3, :token);
    let note_index = 0;
    let amount_1 = 1;
    let amount_2 = 8;
    let note_1 = user_1.new_note(recipient: user_2, :token, amount: amount_1, index: note_index);
    let note_2 = user_1.new_note(recipient: user_3, :token, amount: amount_2, index: note_index);

    let (nullifiers, new_notes) = user_1
        .transfer(
            notes_to_use: [NotePath { channel_index: 0, note_index: 0 }].span(),
            notes_to_create: [note_1, note_2].span(),
        );

    // Test use_note output.
    let expected_nullifiers = [].span();
    assert_eq!(nullifiers, expected_nullifiers);

    // Test create_note output.
    let channel_key = compute_channel_key(
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        :token,
    );
    let note_id = compute_note_id(:channel_key, index: note_index, public_key: user_2.public_key);
    let enc_amount = encrypt_note_amount(:channel_key, index: note_index, amount: amount_1);
    let enc_note_1 = EncNote { id: note_id, enc_amount };
    let channel_key = compute_channel_key(
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        recipient_addr: user_3.address,
        recipient_public_key: user_3.public_key,
        :token,
    );
    let note_id = compute_note_id(:channel_key, index: note_index, public_key: user_3.public_key);
    let enc_amount = encrypt_note_amount(:channel_key, index: note_index, amount: amount_2);
    let enc_note_2 = EncNote { id: note_id, enc_amount };
    let expected_new_notes = [enc_note_1, enc_note_2].span();
    assert_eq!(new_notes, expected_new_notes);
}

#[test]
fn test_transfer_many_to_one() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.new_token();
    user_1.register_server();
    user_2.register_server();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 2;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);

    let (nullifiers, new_notes) = user_1
        .transfer(
            notes_to_use: [
                NotePath { channel_index: 0, note_index: 0 },
                NotePath { channel_index: 0, note_index: 1 },
            ]
                .span(),
            notes_to_create: [note].span(),
        );

    // Test use_note output.
    let expected_nullifiers = [].span();
    assert_eq!(nullifiers, expected_nullifiers);

    // Test create_note output.
    let channel_key = compute_channel_key(
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        :token,
    );
    let note_id = compute_note_id(:channel_key, index: note_index, public_key: user_2.public_key);
    let enc_amount = encrypt_note_amount(:channel_key, index: note_index, :amount);
    let expected_new_notes = [EncNote { id: note_id, enc_amount }].span();
    assert_eq!(new_notes, expected_new_notes);
}

#[test]
#[feature("safe_dispatcher")]
fn test_transfer_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.new_token();

    // Catch NO_NOTES_TO_USE.
    let result = user_1
        .safe_transfer(
            notes_to_use: [].span(),
            notes_to_create: [
                NewNote { recipient_addr: user_2.address, token, amount: 1, index: 0 }
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::NO_NOTES_TO_USE);

    // Catch NO_NOTES_TO_CREATE.
    let result = user_1
        .safe_transfer(
            notes_to_use: [NotePath { channel_index: 0, note_index: 0 }].span(),
            notes_to_create: [].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::NO_NOTES_TO_CREATE);

    // Create note errors.

    // Catch ZERO_RECIPIENT.
    let result = user_1
        .safe_transfer(
            notes_to_use: [NotePath { channel_index: 0, note_index: 0 }].span(),
            notes_to_create: [NewNote { recipient_addr: Zero::zero(), token, amount: 1, index: 0 }]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_transfer(
            notes_to_use: [NotePath { channel_index: 0, note_index: 0 }].span(),
            notes_to_create: [
                NewNote {
                    recipient_addr: user_2.address, token: Zero::zero(), amount: 1, index: 0,
                },
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT.
    let result = user_1
        .safe_transfer(
            notes_to_use: [NotePath { channel_index: 0, note_index: 0 }].span(),
            notes_to_create: [
                NewNote { recipient_addr: user_2.address, token, amount: Zero::zero(), index: 0 },
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::ZERO_AMOUNT);

    // Catch RECIPIENT_NOT_REGISTERED.
    let result = user_1
        .safe_transfer(
            notes_to_use: [NotePath { channel_index: 0, note_index: 0 }].span(),
            notes_to_create: [
                NewNote { recipient_addr: user_2.address, token, amount: 1, index: 0 }
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::RECIPIENT_NOT_REGISTERED);

    user_2.register_server();

    // Catch CHANNEL_NOT_FOUND.
    let result = user_1
        .safe_transfer(
            notes_to_use: [NotePath { channel_index: 0, note_index: 0 }].span(),
            notes_to_create: [
                NewNote { recipient_addr: user_2.address, token, amount: 1, index: 0 }
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::CHANNEL_NOT_FOUND);

    user_1.register_server();
    user_1.open_channel_e2e(recipient: user_2, :token);

    // Catch NOTE_INDEX_NOT_SEQUENTIAL.
    let result = user_1
        .safe_transfer(
            notes_to_use: [NotePath { channel_index: 0, note_index: 0 }].span(),
            notes_to_create: [
                NewNote { recipient_addr: user_2.address, token, amount: 1, index: 1 }
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::NOTE_INDEX_NOT_SEQUENTIAL);
}

#[test]
fn test_open_channel() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_server();
    user_2.register_server();
    let token = test.new_token();

    let (random, channel_output) = user_1
        .open_channel_with_generated_random(recipient: user_2, :token);
    let (recipient_addr, enc_channel_info, channel_id) = channel_output;
    assert_eq!(recipient_addr, user_2.address);
    let channel_key = compute_channel_key(
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        :token,
    );
    // TODO: Is it ok for tests to reuse the same util function as the contract?
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random,
        recipient_public_key: user_2.public_key,
        :channel_key,
        :token,
        sender_addr: user_1.address,
    );
    let expected_channel_id = compute_channel_id(:channel_key);
    assert_eq!(enc_channel_info, expected_enc_channel_info);
    assert_eq!(channel_id, expected_channel_id);
}

#[test]
fn test_open_channel_self_channel() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.register_server();
    let token = test.new_token();

    let (random, channel_output) = user.open_channel_with_generated_random(recipient: user, :token);
    let (recipient_addr, enc_channel_info, channel_id) = channel_output;
    assert_eq!(recipient_addr, user.address);
    let channel_key = compute_channel_key(
        sender_addr: user.address,
        sender_private_key: user.private_key,
        recipient_addr: user.address,
        recipient_public_key: user.public_key,
        :token,
    );
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random,
        recipient_public_key: user.public_key,
        :channel_key,
        :token,
        sender_addr: user.address,
    );
    let expected_channel_id = compute_channel_id(:channel_key);
    assert_eq!(enc_channel_info, expected_enc_channel_info);
    assert_eq!(channel_id, expected_channel_id);
}

#[test]
#[feature("safe_dispatcher")]
fn test_open_channel_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.new_token();
    let random = user_1.get_random();

    // Catch ZERO_SENDER_ADDR.
    let mut user_zero_addr = user_1;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_open_channel(recipient: user_2, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: Errors::ZERO_SENDER_ADDR);

    // Catch ZERO_SENDER_PRIVATE_KEY.
    let mut user_zero_private_key = user_1;
    user_zero_private_key.private_key = Zero::zero();
    let result = user_zero_private_key.safe_open_channel(recipient: user_2, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: Errors::ZERO_SENDER_PRIVATE_KEY);

    // Catch ZERO_RECIPIENT_ADDR.
    let mut user_zero_addr = user_2;
    user_zero_addr.address = Zero::zero();
    let result = user_1.safe_open_channel(recipient: user_zero_addr, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: Errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_TOKEN.
    let result = user_1.safe_open_channel(recipient: user_2, token: Zero::zero(), :random);
    assert_panic_with_felt_error(:result, expected_error: Errors::ZERO_TOKEN);

    // Catch ZERO_RANDOM.
    let result = user_1.safe_open_channel(recipient: user_2, :token, random: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: Errors::ZERO_RANDOM);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_invalid_private_key = user_1;
    user_invalid_private_key.private_key = Neg::neg(user_invalid_private_key.private_key);
    let result = user_invalid_private_key.safe_open_channel(recipient: user_2, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: Errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch SENDER_NOT_REGISTERED.
    let result = user_1.safe_open_channel(recipient: user_2, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: Errors::SENDER_NOT_REGISTERED);

    // Catch SENDER_NOT_AUTHENTICATED.
    user_1.register_server();
    let user_1_private_key = user_1.private_key;
    user_1.private_key = user_1.public_key;
    if !is_canonical_key(key: user_1.private_key) {
        user_1.private_key = Neg::neg(user_1.private_key);
    }
    let result = user_1.safe_open_channel(recipient: user_2, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: Errors::SENDER_NOT_AUTHENTICATED);
    user_1.private_key = user_1_private_key;

    // Catch RECIPIENT_NOT_REGISTERED - recipient not registered.
    let result = user_1.safe_open_channel(recipient: user_2, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: Errors::RECIPIENT_NOT_REGISTERED);
}

#[test]
fn test_open_channel_multiple_channels_same_sender() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let user_3 = test.new_user();
    user_1.register_server();
    user_2.register_server();
    user_3.register_server();
    let token = test.new_token();

    let (random_1, c1_output) = user_1
        .open_channel_with_generated_random(recipient: user_2, :token);
    let (random_2, c2_output) = user_1
        .open_channel_with_generated_random(recipient: user_3, :token);
    let (c1_recipient_addr, c1_enc_channel_info, c1_channel_id) = c1_output;
    let (c2_recipient_addr, c2_enc_channel_info, c2_channel_id) = c2_output;
    assert_eq!(c1_recipient_addr, user_2.address);
    assert_eq!(c2_recipient_addr, user_3.address);
    let channel_key_1 = compute_channel_key(
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        :token,
    );
    let channel_key_2 = compute_channel_key(
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        recipient_addr: user_3.address,
        recipient_public_key: user_3.public_key,
        :token,
    );
    assert_ne!(channel_key_1, channel_key_2);
    let expected_enc_channel_info_1 = encrypt_channel_info(
        ephemeral_secret: random_1,
        recipient_public_key: user_2.public_key,
        channel_key: channel_key_1,
        :token,
        sender_addr: user_1.address,
    );
    let expected_enc_channel_info_2 = encrypt_channel_info(
        ephemeral_secret: random_2,
        recipient_public_key: user_3.public_key,
        channel_key: channel_key_2,
        :token,
        sender_addr: user_1.address,
    );
    assert_ne!(
        expected_enc_channel_info_1.ephemeral_pubkey, expected_enc_channel_info_2.ephemeral_pubkey,
    );
    assert_ne!(
        expected_enc_channel_info_1.enc_channel_key, expected_enc_channel_info_2.enc_channel_key,
    );
    assert_ne!(expected_enc_channel_info_1.enc_token, expected_enc_channel_info_2.enc_token);
    assert_ne!(
        expected_enc_channel_info_1.enc_sender_addr, expected_enc_channel_info_2.enc_sender_addr,
    );
    assert_eq!(c1_enc_channel_info, expected_enc_channel_info_1);
    assert_eq!(c2_enc_channel_info, expected_enc_channel_info_2);
    let expected_channel_id_1 = compute_channel_id(channel_key: channel_key_1);
    let expected_channel_id_2 = compute_channel_id(channel_key: channel_key_2);
    assert_ne!(expected_channel_id_1, expected_channel_id_2);
    assert_eq!(c1_channel_id, expected_channel_id_1);
    assert_eq!(c2_channel_id, expected_channel_id_2);
}


#[test]
fn test_open_channel_multiple_channels_same_recipient() {
    let mut test = Default::default();
    let user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    user_1.register_server();
    user_2.register_server();
    user_3.register_server();
    let token = test.new_token();

    let (random_1, c1_output) = user_2
        .open_channel_with_generated_random(recipient: user_1, :token);
    let (random_2, c2_output) = user_3
        .open_channel_with_generated_random(recipient: user_1, :token);
    let (c1_recipient_addr, c1_enc_channel_info, c1_channel_id) = c1_output;
    let (c2_recipient_addr, c2_enc_channel_info, c2_channel_id) = c2_output;
    assert_eq!(c1_recipient_addr, user_1.address);
    assert_eq!(c2_recipient_addr, user_1.address);
    let channel_key_1 = compute_channel_key(
        sender_addr: user_2.address,
        sender_private_key: user_2.private_key,
        recipient_addr: user_1.address,
        recipient_public_key: user_1.public_key,
        :token,
    );
    let channel_key_2 = compute_channel_key(
        sender_addr: user_3.address,
        sender_private_key: user_3.private_key,
        recipient_addr: user_1.address,
        recipient_public_key: user_1.public_key,
        :token,
    );
    assert_ne!(channel_key_1, channel_key_2);
    let expected_enc_channel_info_1 = encrypt_channel_info(
        ephemeral_secret: random_1,
        recipient_public_key: user_1.public_key,
        channel_key: channel_key_1,
        :token,
        sender_addr: user_2.address,
    );
    let expected_enc_channel_info_2 = encrypt_channel_info(
        ephemeral_secret: random_2,
        recipient_public_key: user_1.public_key,
        channel_key: channel_key_2,
        :token,
        sender_addr: user_3.address,
    );
    // The ephemeral public keys are identical (same recipient and both users use the same random).
    assert_eq!(
        expected_enc_channel_info_1.ephemeral_pubkey, expected_enc_channel_info_2.ephemeral_pubkey,
    );
    assert_ne!(
        expected_enc_channel_info_1.enc_channel_key, expected_enc_channel_info_2.enc_channel_key,
    );
    // Encrypted tokens are identical (ephemeral public keys and tokens are the same).
    assert_eq!(expected_enc_channel_info_1.enc_token, expected_enc_channel_info_2.enc_token);
    assert_ne!(
        expected_enc_channel_info_1.enc_sender_addr, expected_enc_channel_info_2.enc_sender_addr,
    );
    assert_eq!(c1_enc_channel_info, expected_enc_channel_info_1);
    assert_eq!(c2_enc_channel_info, expected_enc_channel_info_2);
    let expected_channel_id_1 = compute_channel_id(channel_key: channel_key_1);
    let expected_channel_id_2 = compute_channel_id(channel_key: channel_key_2);
    assert_ne!(expected_channel_id_1, expected_channel_id_2);
    assert_eq!(c1_channel_id, expected_channel_id_1);
    assert_eq!(c2_channel_id, expected_channel_id_2);
}

#[test]
fn test_open_channel_multiple_tokens() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_server();
    user_2.register_server();
    let token_1 = test.new_token();
    let token_2 = test.new_token();

    let (random_1, c1_output) = user_1
        .open_channel_with_generated_random(recipient: user_2, token: token_1);
    let (random_2, c2_output) = user_1
        .open_channel_with_generated_random(recipient: user_2, token: token_2);
    let (c1_recipient_addr, c1_enc_channel_info, c1_channel_id) = c1_output;
    let (c2_recipient_addr, c2_enc_channel_info, c2_channel_id) = c2_output;
    assert_eq!(c1_recipient_addr, user_2.address);
    assert_eq!(c2_recipient_addr, user_2.address);
    let channel_key_1 = compute_channel_key(
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        token: token_1,
    );
    let channel_key_2 = compute_channel_key(
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        token: token_2,
    );
    assert_ne!(channel_key_1, channel_key_2);
    let expected_enc_channel_info_1 = encrypt_channel_info(
        ephemeral_secret: random_1,
        recipient_public_key: user_2.public_key,
        channel_key: channel_key_1,
        token: token_1,
        sender_addr: user_1.address,
    );
    let expected_enc_channel_info_2 = encrypt_channel_info(
        ephemeral_secret: random_2,
        recipient_public_key: user_2.public_key,
        channel_key: channel_key_2,
        token: token_2,
        sender_addr: user_1.address,
    );
    assert_ne!(
        expected_enc_channel_info_1.ephemeral_pubkey, expected_enc_channel_info_2.ephemeral_pubkey,
    );
    assert_ne!(
        expected_enc_channel_info_1.enc_channel_key, expected_enc_channel_info_2.enc_channel_key,
    );
    assert_ne!(expected_enc_channel_info_1.enc_token, expected_enc_channel_info_2.enc_token);
    assert_ne!(
        expected_enc_channel_info_1.enc_sender_addr, expected_enc_channel_info_2.enc_sender_addr,
    );
    assert_eq!(c1_enc_channel_info, expected_enc_channel_info_1);
    assert_eq!(c2_enc_channel_info, expected_enc_channel_info_2);
    let expected_channel_id_1 = compute_channel_id(channel_key: channel_key_1);
    let expected_channel_id_2 = compute_channel_id(channel_key: channel_key_2);
    assert_ne!(expected_channel_id_1, expected_channel_id_2);
    assert_eq!(c1_channel_id, expected_channel_id_1);
    assert_eq!(c2_channel_id, expected_channel_id_2);
}

#[test]
fn test_open_channel_self_channel_multiple_tokens() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.register_server();
    let token_1 = test.new_token();
    let token_2 = test.new_token();

    let (random_1, c1_output) = user
        .open_channel_with_generated_random(recipient: user, token: token_1);
    let (random_2, c2_output) = user
        .open_channel_with_generated_random(recipient: user, token: token_2);
    let (c1_recipient_addr, c1_enc_channel_info, c1_channel_id) = c1_output;
    let (c2_recipient_addr, c2_enc_channel_info, c2_channel_id) = c2_output;
    assert_eq!(c1_recipient_addr, user.address);
    assert_eq!(c2_recipient_addr, user.address);
    let channel_key_1 = compute_channel_key(
        sender_addr: user.address,
        sender_private_key: user.private_key,
        recipient_addr: user.address,
        recipient_public_key: user.public_key,
        token: token_1,
    );
    let channel_key_2 = compute_channel_key(
        sender_addr: user.address,
        sender_private_key: user.private_key,
        recipient_addr: user.address,
        recipient_public_key: user.public_key,
        token: token_2,
    );
    assert_ne!(channel_key_1, channel_key_2);
    let expected_enc_channel_info_1 = encrypt_channel_info(
        ephemeral_secret: random_1,
        recipient_public_key: user.public_key,
        channel_key: channel_key_1,
        token: token_1,
        sender_addr: user.address,
    );
    let expected_enc_channel_info_2 = encrypt_channel_info(
        ephemeral_secret: random_2,
        recipient_public_key: user.public_key,
        channel_key: channel_key_2,
        token: token_2,
        sender_addr: user.address,
    );
    assert_ne!(
        expected_enc_channel_info_1.ephemeral_pubkey, expected_enc_channel_info_2.ephemeral_pubkey,
    );
    assert_ne!(
        expected_enc_channel_info_1.enc_channel_key, expected_enc_channel_info_2.enc_channel_key,
    );
    assert_ne!(expected_enc_channel_info_1.enc_token, expected_enc_channel_info_2.enc_token);
    assert_ne!(
        expected_enc_channel_info_1.enc_sender_addr, expected_enc_channel_info_2.enc_sender_addr,
    );
    assert_eq!(c1_enc_channel_info, expected_enc_channel_info_1);
    assert_eq!(c2_enc_channel_info, expected_enc_channel_info_2);
    let expected_channel_id_1 = compute_channel_id(channel_key: channel_key_1);
    let expected_channel_id_2 = compute_channel_id(channel_key: channel_key_2);
    assert_ne!(expected_channel_id_1, expected_channel_id_2);
    assert_eq!(c1_channel_id, expected_channel_id_1);
    assert_eq!(c2_channel_id, expected_channel_id_2);
}
// TODO: Test open channels with same sender and same random.

// TODO: Consider move this test to common test file.
#[test]
fn test_open_channel_decrypt_channel_info() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_server();
    user_2.register_server();
    let token = test.new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);

    // User 2 should be able to decrypt the channel info.
    assert_eq!(user_2.get_num_of_channels_server(), 1);
    let enc_channel_info = user_2.get_enc_channel_info_server(channel_index: 0);
    let (decrypted_channel_key, decrypted_token, decrypted_sender_addr) = decrypt_channel_info(
        :enc_channel_info, private_key: user_2.private_key,
    );

    // Verify decrypted channel key.
    let expected_channel_key = compute_channel_key(
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        :token,
    );
    assert_eq!(decrypted_channel_key, expected_channel_key);

    // Verify decrypted token.
    assert_eq!(decrypted_token.try_into().unwrap(), token);

    // Verify decrypted sender address.
    assert_eq!(decrypted_sender_addr, user_1.address);
}

#[test]
fn test_create_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_server();
    user_2.register_server();
    let token = test.new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);
    let (enc_note, note_amount) = user_1.create_note(:note);
    assert_eq!(note_amount, amount);
    let channel_key = compute_channel_key(
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        :token,
    );
    let note_id = compute_note_id(:channel_key, index: note_index, public_key: user_2.public_key);
    let enc_amount = encrypt_note_amount(:channel_key, index: note_index, :amount);
    assert_eq!(enc_note.id, note_id);
    assert_eq!(enc_note.enc_amount, enc_amount);
}

#[test]
fn test_create_note_self_note() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.register_server();
    let token = test.new_token();
    user.open_channel_e2e(recipient: user, :token);
    let amount = 1;
    let note_index = 0;
    let note = user.new_note(recipient: user, :token, :amount, index: note_index);
    let (enc_note, note_amount) = user.create_note(:note);
    assert_eq!(note_amount, amount);
    let channel_key = compute_channel_key(
        sender_addr: user.address,
        sender_private_key: user.private_key,
        recipient_addr: user.address,
        recipient_public_key: user.public_key,
        :token,
    );
    let note_id = compute_note_id(:channel_key, index: note_index, public_key: user.public_key);
    let enc_amount = encrypt_note_amount(:channel_key, index: note_index, :amount);
    assert_eq!(enc_note.id, note_id);
    assert_eq!(enc_note.enc_amount, enc_amount);
}

#[test]
fn test_create_note_twice() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_server();
    user_2.register_server();
    let token = test.new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount_1 = 1;
    let note_index_1 = 0;
    let note_1 = user_1.new_note(recipient: user_2, :token, amount: amount_1, index: note_index_1);
    let (enc_note_1, note_amount_1) = user_1.create_note(note: note_1);
    let amount_2 = amount_1 + 1;
    let note_index_2 = note_index_1 + 1;
    user_1.create_note_server(enc_note_1);
    let note_2 = user_1.new_note(recipient: user_2, :token, amount: amount_2, index: note_index_2);
    let (enc_note_2, note_amount_2) = user_1.create_note(note: note_2);
    assert_eq!(note_amount_1, amount_1);
    assert_eq!(note_amount_2, amount_2);
    assert_ne!(enc_note_1.id, enc_note_2.id);
    assert_ne!(enc_note_1.enc_amount, enc_note_2.enc_amount);
    let channel_key = compute_channel_key(
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        :token,
    );
    let note_id_1 = compute_note_id(
        :channel_key, index: note_index_1, public_key: user_2.public_key,
    );
    let note_id_2 = compute_note_id(
        :channel_key, index: note_index_2, public_key: user_2.public_key,
    );
    assert_eq!(enc_note_1.id, note_id_1);
    assert_eq!(enc_note_2.id, note_id_2);
    let enc_amount_1 = encrypt_note_amount(:channel_key, index: note_index_1, amount: amount_1);
    let enc_amount_2 = encrypt_note_amount(:channel_key, index: note_index_2, amount: amount_2);
    assert_eq!(enc_note_1.enc_amount, enc_amount_1);
    assert_eq!(enc_note_2.enc_amount, enc_amount_2);
}

#[test]
fn test_create_note_twice_same_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_server();
    user_2.register_server();
    let token = test.new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index_1 = 0;
    let note_1 = user_1.new_note(recipient: user_2, :token, :amount, index: note_index_1);
    let (enc_note_1, note_amount_1) = user_1.create_note(note: note_1);
    let note_index_2 = note_index_1 + 1;
    user_1.create_note_server(enc_note_1);
    let note_2 = user_1.new_note(recipient: user_2, :token, :amount, index: note_index_2);
    let (enc_note_2, note_amount_2) = user_1.create_note(note: note_2);
    assert_eq!(note_amount_1, amount);
    assert_eq!(note_amount_2, amount);
    assert_ne!(enc_note_1.id, enc_note_2.id);
    assert_ne!(enc_note_1.enc_amount, enc_note_2.enc_amount);
    let channel_key = compute_channel_key(
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        :token,
    );
    let note_id_1 = compute_note_id(
        :channel_key, index: note_index_1, public_key: user_2.public_key,
    );
    let note_id_2 = compute_note_id(
        :channel_key, index: note_index_2, public_key: user_2.public_key,
    );
    assert_eq!(enc_note_1.id, note_id_1);
    assert_eq!(enc_note_2.id, note_id_2);
    let enc_amount_1 = encrypt_note_amount(:channel_key, index: note_index_1, :amount);
    let enc_amount_2 = encrypt_note_amount(:channel_key, index: note_index_2, :amount);
    assert_eq!(enc_note_1.enc_amount, enc_amount_1);
    assert_eq!(enc_note_2.enc_amount, enc_amount_2);
}

#[test]
#[should_panic(expected_error: errors::ZERO_RECIPIENT_ADDR)]
fn test_create_note_zero_recipient_addr() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    user_2.address = Zero::zero();
    let note = user_1.new_note(recipient: user_2, :token, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected_error: errors::ZERO_TOKEN)]
fn test_create_note_zero_token() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let note = user_1.new_note(recipient: user_2, token: Zero::zero(), amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected_error: errors::ZERO_TOKEN)]
fn test_create_note_zero_amount() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.new_token();
    let note = user_1.new_note(recipient: user_2, :token, amount: 0, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected_error: errors::RECIPIENT_NOT_REGISTERED)]
fn test_create_note_recipient_not_registered() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.new_token();
    let note = user_1.new_note(recipient: user_2, :token, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected_error: errors::CHANNEL_NOT_FOUND)]
fn test_create_note_channel_not_found() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_server();
    user_2.register_server();
    let token = test.new_token();
    let note = user_1.new_note(recipient: user_2, :token, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected_error: errors::NOTE_INDEX_NOT_SEQUENTIAL)]
fn test_create_note_note_index_not_sequential() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_server();
    user_2.register_server();
    let token = test.new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: 1);
    user_1.create_note(:note);
}

// TODO: Consider move this test to common test file.
#[test]
fn test_create_note_decrypt_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_server();
    user_2.register_server();
    let token = test.new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);
    let (enc_note, _) = user_1.create_note(:note);
    user_1.create_note_server(enc_note);

    // User 2 should be able to decrypt the amount.
    // Decrypt channel key.
    let enc_channel_info = user_2.get_enc_channel_info_server(channel_index: 0);
    let (channel_key, _, _) = decrypt_channel_info(
        :enc_channel_info, private_key: user_2.private_key,
    );
    let note_id = compute_note_id(:channel_key, index: note_index, public_key: user_2.public_key);
    let enc_amount = user_2.get_note_server(:note_id);
    let decrypted_amount = decrypt_note_amount(
        enc_note_value: enc_amount, :channel_key, index: note_index,
    );
    assert_eq!(decrypted_amount, amount);
}
