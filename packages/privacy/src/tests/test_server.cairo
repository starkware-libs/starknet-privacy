use core::num::traits::Zero;
use privacy::errors;
use privacy::tests::test_utils::{
    PrivacyTokenTrait, ServerCfgTrait, Test, TestTrait, UserTrait, constants,
};
use snforge_std::{CustomToken, Token};
use starkware_utils::erc20::erc20_errors::Erc20Error;
use starkware_utils::errors::Describable;
use starkware_utils_testing::test_utils::{assert_panic_with_error, assert_panic_with_felt_error};

#[test]
fn test_open_channel() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let (enc_channel_info, channel_id) = test.new_channel();
    test
        .cfg
        .open_channel(
            recipient_addr: user.address,
            enc_channel_info: enc_channel_info,
            channel_id: channel_id,
        );
    assert_eq!(test.cfg.channel_exists(:channel_id), true);
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
        .cfg
        .open_channel(
            recipient_addr: user.address,
            enc_channel_info: enc_channel_info_1,
            channel_id: channel_id_1,
        );
    // Open second channel.
    let (enc_channel_info_2, channel_id_2) = test.new_channel();
    test
        .cfg
        .open_channel(
            recipient_addr: user.address,
            enc_channel_info: enc_channel_info_2,
            channel_id: channel_id_2,
        );

    assert_eq!(test.cfg.channel_exists(channel_id: channel_id_1), true);
    assert_eq!(test.cfg.channel_exists(channel_id: channel_id_2), true);
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
        .cfg
        .safe_open_channel(recipient_addr: Zero::zero(), :enc_channel_info, :channel_id);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_ENC_CHANNEL_INFO (ephemeral_pubkey).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.ephemeral_pubkey = Zero::zero();
    let result = test
        .cfg
        .safe_open_channel(:recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_id);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_ENC_CHANNEL_INFO (enc_channel_key).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.enc_channel_key = Zero::zero();
    let result = test
        .cfg
        .safe_open_channel(:recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_id);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_ENC_CHANNEL_INFO (enc_token).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.enc_token = Zero::zero();
    let result = test
        .cfg
        .safe_open_channel(:recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_id);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_ENC_CHANNEL_INFO (enc_sender_addr).
    let mut enc_channel_info_zero = enc_channel_info;
    enc_channel_info_zero.enc_sender_addr = Zero::zero();
    let result = test
        .cfg
        .safe_open_channel(:recipient_addr, enc_channel_info: enc_channel_info_zero, :channel_id);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_CHANNEL_INFO);

    // Catch ZERO_CHANNEL_ID.
    let result = test
        .cfg
        .safe_open_channel(:recipient_addr, :enc_channel_info, channel_id: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_CHANNEL_ID);

    // Catch CHANNEL_ALREADY_EXISTS.
    test.cfg.open_channel(:recipient_addr, :enc_channel_info, :channel_id);
    let result = test.cfg.safe_open_channel(:recipient_addr, :enc_channel_info, :channel_id);
    assert_panic_with_felt_error(:result, expected_error: errors::CHANNEL_ALREADY_EXISTS);
}

#[test]
fn test_channel_exists() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let recipient_addr = user.address;
    let (enc_channel_info, channel_id) = test.new_channel();
    assert_eq!(test.cfg.channel_exists(:channel_id), false);
    test.cfg.open_channel(:recipient_addr, :enc_channel_info, :channel_id);
    assert_eq!(test.cfg.channel_exists(:channel_id), true);
    let (_, channel_id) = test.new_channel();
    assert_eq!(test.cfg.channel_exists(:channel_id), false);
}

#[test]
fn test_get_num_of_channels() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let recipient_addr = user.address;
    // TODO: Test before registeration and after registration.
    assert_eq!(user.get_num_of_channels(), 0);
    let (enc_channel_info, channel_id) = test.new_channel();
    test.cfg.open_channel(:recipient_addr, :enc_channel_info, :channel_id);
    assert_eq!(user.get_num_of_channels(), 1);
    let (enc_channel_info, channel_id) = test.new_channel();
    test.cfg.open_channel(:recipient_addr, :enc_channel_info, :channel_id);
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
        .cfg
        .open_channel(
            recipient_addr: user_1.address,
            enc_channel_info: channel_1_user_1,
            channel_id: channel_id_1_user_1,
        );
    test
        .cfg
        .open_channel(
            recipient_addr: user_1.address,
            enc_channel_info: channel_2_user_1,
            channel_id: channel_id_2_user_1,
        );
    test
        .cfg
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
    test
        .cfg
        .open_channel(
            recipient_addr: user.address,
            enc_channel_info: enc_channel_info,
            channel_id: channel_id,
        );

    let result = user.safe_get_channel_info(channel_index: 0);
    assert!(result.is_ok());
    let result = user.safe_get_channel_info(channel_index: 1);
    assert_panic_with_error(:result, expected_error: "Index out of bounds");
}

#[test]
fn test_get_note() {
    let mut test: Test = Default::default();
    let note = test.new_note_server(amount: constants::DEFAULT_AMOUNT);
    assert_eq!(test.cfg.get_note(note_id: note.id), Zero::zero());
    test.cfg.create_note(:note);
    assert_eq!(test.cfg.get_note(note_id: note.id), note.enc_amount);
}

#[test]
fn test_create_note() {
    let mut test: Test = Default::default();
    let note = test.new_note_server(amount: constants::DEFAULT_AMOUNT);
    test.cfg.create_note(:note);
    assert_eq!(test.cfg.get_note(note_id: note.id), note.enc_amount);
}

#[test]
fn test_create_note_twice() {
    let mut test: Test = Default::default();
    let amount = constants::DEFAULT_AMOUNT;
    let note_1 = test.new_note_server(:amount);
    test.cfg.create_note(note: note_1);
    let note_2 = test.new_note_server(:amount);
    test.cfg.create_note(note: note_2);
    assert_eq!(test.cfg.get_note(note_id: note_1.id), note_1.enc_amount);
    assert_eq!(test.cfg.get_note(note_id: note_2.id), note_2.enc_amount);
}


// TODO: Figure out how to safely call internal functions.
#[test]
#[should_panic(expected_error: errors::ZERO_NOTE_ID)]
fn test_create_note_zero_note_id() {
    let mut test: Test = Default::default();
    let mut note = test.new_note_server(amount: constants::DEFAULT_AMOUNT);
    note.id = Zero::zero();
    test.cfg.create_note(:note);
}

#[test]
#[should_panic(expected_error: errors::ZERO_ENC_NOTE_VALUE)]
fn test_create_note_zero_enc_note_value() {
    let mut test: Test = Default::default();
    let mut note = test.new_note_server(amount: constants::DEFAULT_AMOUNT);
    note.enc_amount = Zero::zero();
    test.cfg.create_note(:note);
}

#[test]
#[should_panic(expected_error: errors::NOTE_ALREADY_EXISTS)]
fn test_create_note_note_already_exists() {
    let mut test: Test = Default::default();
    let amount = constants::DEFAULT_AMOUNT;
    let note = test.new_note_server(:amount);
    test.cfg.create_note(:note);
    let mut diff_note = test.new_note_server(:amount);
    diff_note.id = note.id;
    test.cfg.create_note(note: diff_note);
}

#[test]
fn test_nullifier_exists() {
    let mut test: Test = Default::default();
    let nullifier = test.new_nullifier();
    assert_eq!(test.cfg.nullifier_exists(:nullifier), false);
    test.cfg.use_note(:nullifier);
    assert_eq!(test.cfg.nullifier_exists(:nullifier), true);
}

#[test]
fn test_use_note() {
    let mut test: Test = Default::default();
    let nullifier = test.new_nullifier();
    test.cfg.use_note(:nullifier);
    assert_eq!(test.cfg.nullifier_exists(:nullifier), true);
}

#[test]
fn test_use_note_twice() {
    let mut test: Test = Default::default();
    let nullifier_1 = test.new_nullifier();
    let nullifier_2 = test.new_nullifier();
    test.cfg.use_note(nullifier: nullifier_1);
    test.cfg.use_note(nullifier: nullifier_2);
    assert_eq!(test.cfg.nullifier_exists(nullifier: nullifier_1), true);
    assert_eq!(test.cfg.nullifier_exists(nullifier: nullifier_2), true);
}

#[test]
#[should_panic(expected_error: errors::ZERO_NULLIFIER)]
fn test_use_note_zero_nullifier() {
    let mut test: Test = Default::default();
    test.cfg.use_note(nullifier: Zero::zero());
}

#[test]
#[should_panic(expected_error: errors::NULLIFIER_ALREADY_EXISTS)]
fn test_use_note_nullifier_already_exists() {
    let mut test: Test = Default::default();
    let nullifier = test.new_nullifier();
    test.cfg.use_note(nullifier: nullifier);
    test.cfg.use_note(nullifier: nullifier);
}

#[test]
fn test_register() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let public_key = user.public_key;
    user.register();
    // Verify that user is registered with the correct public key.
    assert_eq!(user.get_public_key(), public_key);
}

#[test]
#[feature("safe_dispatcher")]
fn test_register_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let non_zero_public_key = user.public_key;

    // Catch ZERO_PUBLIC_KEY.
    user.public_key = Zero::zero();
    let result = user.safe_register();
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PUBLIC_KEY);

    // Catch USER_ALREADY_REGISTERED.
    user.public_key = non_zero_public_key;
    user.register();
    let result = user.safe_register();
    assert_panic_with_felt_error(:result, expected_error: errors::USER_ALREADY_REGISTERED);
}

#[test]
fn test_get_public_key() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    // Don't register the user.
    assert_eq!(user.get_public_key(), Zero::zero());
    // Register the user.
    user.register();
    assert_eq!(user.get_public_key(), user.public_key);
}

#[test]
fn test_replace_public_key() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let original_public_key = user.public_key;

    // Register the user first.
    user.register();
    assert_eq!(user.get_public_key(), original_public_key);

    // Replace the public key first time.
    user.new_public_key();
    user.replace_public_key();
    assert_eq!(user.get_public_key(), user.public_key);

    // Replace the public key second time.
    user.new_public_key();
    user.replace_public_key();
    assert_eq!(user.get_public_key(), user.public_key);

    // Replace back to original public key.
    user.public_key = original_public_key;
    user.replace_public_key();
    assert_eq!(user.get_public_key(), original_public_key);
}

#[test]
fn test_replace_public_key_same_key() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let original_public_key = user.public_key;

    // Register the user first.
    user.register();
    assert_eq!(user.get_public_key(), original_public_key);

    // Replace with the same public key.
    user.replace_public_key();
    assert_eq!(user.get_public_key(), original_public_key);
}

#[test]
fn test_replace_public_key_to_other_user_key() {
    let mut test: Test = Default::default();
    let mut user1 = test.new_user();
    let user2 = test.new_user();
    let user1_original_key = user1.public_key;
    let user2_public_key = user2.public_key;

    // Register both users.
    user1.register();
    user2.register();

    // Verify initial keys.
    assert_eq!(user1.get_public_key(), user1_original_key);
    assert_eq!(user2.get_public_key(), user2_public_key);

    // User1 replaces their public key to user2's public key.
    user1.public_key = user2_public_key;
    user1.replace_public_key();

    // Verify user1 now has user2's public key.
    assert_eq!(user1.get_public_key(), user2_public_key);
    // Verify user2's key is unchanged.
    assert_eq!(user2.get_public_key(), user2_public_key);
}

#[test]
#[feature("safe_dispatcher")]
fn test_replace_public_key_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();

    // Catch ZERO_PUBLIC_KEY.
    user.register();
    user.public_key = Zero::zero();
    let result = user.safe_replace_public_key();
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PUBLIC_KEY);

    // Catch USER_NOT_REGISTERED.
    let unregistered_user = test.new_user();
    let result = unregistered_user.safe_replace_public_key();
    assert_panic_with_felt_error(:result, expected_error: errors::USER_NOT_REGISTERED);
}

#[test]
fn test_register_multiple_users() {
    let mut test: Test = Default::default();
    let user1 = test.new_user();
    let user2 = test.new_user();
    let user3 = test.new_user();
    let public_key1 = user1.public_key;
    let public_key2 = user2.public_key;
    assert_ne!(public_key1, public_key2, "Public keys should be different.");

    // Register user1.
    user1.register();

    // Register user2.
    user2.register();

    // Verify both public keys are stored correctly.
    assert_eq!(user1.get_public_key(), public_key1);
    assert_eq!(user2.get_public_key(), public_key2);
    // User3 has not registered, so get_public_key should return zero.
    assert_eq!(user3.get_public_key(), Zero::zero());
}

#[test]
fn test_register_multiple_users_same_public_key() {
    let mut test: Test = Default::default();
    let user1 = test.new_user();
    let mut user2 = test.new_user();

    // Set the same public key for both users.
    let shared_public_key = user1.public_key;
    user2.public_key = shared_public_key;

    // Register both users.
    user1.register();
    user2.register();

    // Both should be able to fetch the shared public key.
    assert_eq!(user1.get_public_key(), shared_public_key);
    assert_eq!(user2.get_public_key(), shared_public_key);
}

#[test]
fn test_deposit() {
    let mut test: Test = Default::default();
    let token = test.new_token_server();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    token.supply(:user, :amount);
    let note = test.new_note_server(:amount);

    // Check balances
    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.cfg.address), Zero::zero());

    // Deposit
    user.deposit_server(:token, :amount, :note);

    // Check balances after deposit
    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.cfg.address), amount.into());

    // Check storage
    assert_eq!(test.cfg.get_note(note_id: note.id), note.enc_amount);
}

#[test]
#[feature("safe_dispatcher")]
fn test_deposit_assertions() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let token = test.new_token_server();
    let zero_token = Token::Custom(
        CustomToken { contract_address: Zero::zero(), balances_variable_selector: Zero::zero() },
    );
    let amount = constants::DEFAULT_AMOUNT;
    let note = test.new_note_server(:amount);

    // Catch ZERO_TOKEN
    let result = user.safe_deposit_server(token: zero_token, :amount, :note);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT
    let result = user.safe_deposit_server(:token, amount: Zero::zero(), :note);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);

    // Catch ZERO_USER_ADDR
    let mut zero_user = test.new_user();
    zero_user.address = Zero::zero();
    let result = zero_user.safe_deposit_server(:token, :amount, :note);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch ZERO_NOTE_ID
    let mut zero_note = test.new_note_server(:amount);
    zero_note.id = Zero::zero();
    let result = user.safe_deposit_server(:token, :amount, note: zero_note);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_NOTE_ID);

    // Catch ZERO_ENC_NOTE_VALUE
    let mut zero_note = test.new_note_server(:amount);
    zero_note.enc_amount = Zero::zero();
    let result = user.safe_deposit_server(:token, :amount, note: zero_note);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_NOTE_VALUE);

    // Catch INSUFFICIENT_BALANCE
    let result = user.safe_deposit_server(:token, :amount, :note);
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());

    // Catch INSUFFICIENT_ALLOWANCE
    let note = test.new_note_server(:amount); // New note because of snforge revert storage bug.
    token.supply(:user, :amount);
    let result = user.safe_deposit_server(:token, :amount, :note);
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_ALLOWANCE.describe());

    // Catch NOTE_ALREADY_EXISTS (same user)
    let note = test.new_note_server(:amount); // New note because of snforge revert storage bug.
    user.deposit_server(:token, :amount, :note);
    let result = user.safe_deposit_server(:token, :amount, :note);
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_ALREADY_EXISTS);

    // Catch NOTE_ALREADY_EXISTS (different user)
    let different_user = test.new_user();
    token.supply(user: different_user, :amount);
    let result = different_user.safe_deposit_server(:token, :amount, :note);
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_ALREADY_EXISTS);
}

#[test]
fn test_transfer() {
    let mut test: Test = Default::default();
    let token = test.new_token_server();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    token.supply(:user, :amount);
    let note = test.new_note_server(:amount);
    let nullifier = test.new_nullifier();
    let new_note = test.new_note_server(:amount);

    // Deposit
    user.deposit_server(:token, :amount, :note);

    // Verify balances before.
    assert_eq!(token.balance_of(address: test.cfg.address), amount.into());
    assert_eq!(token.balance_of(address: user.address), Zero::zero());

    // Check storage before.
    assert_eq!(test.cfg.get_note(note_id: note.id), note.enc_amount);
    assert_eq!(test.cfg.get_note(note_id: new_note.id), Zero::zero());
    assert_eq!(test.cfg.nullifier_exists(:nullifier), false);

    // Transfer
    test.cfg.transfer(nullifiers: [nullifier].span(), new_notes: [new_note].span());

    // Verify balances haven't changed.
    assert_eq!(token.balance_of(address: test.cfg.address), amount.into());
    assert_eq!(token.balance_of(address: user.address), Zero::zero());

    // Check storage after.
    assert_eq!(test.cfg.get_note(note_id: note.id), note.enc_amount);
    assert_eq!(test.cfg.get_note(note_id: new_note.id), new_note.enc_amount);
    assert_eq!(test.cfg.nullifier_exists(:nullifier), true);
    // TODO: Test user balances in contract.
}

#[test]
fn test_transfer_assertions() {
    let mut test: Test = Default::default();
    let token = test.new_token_server();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    let note = test.new_note_server(:amount);
    let nullifier = test.new_nullifier();

    // Catch EMPTY_NULLIFIERS
    let result = test.cfg.safe_transfer(nullifiers: [].span(), new_notes: [note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::EMPTY_NULLIFIERS);

    // Catch EMPTY_NEW_NOTES
    let result = test.cfg.safe_transfer(nullifiers: [nullifier].span(), new_notes: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::EMPTY_NEW_NOTES);

    // Catch ZERO_NULLIFIER
    let result = test
        .cfg
        .safe_transfer(nullifiers: [Zero::zero()].span(), new_notes: [note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_NULLIFIER);

    // Catch NULLIFIER_ALREADY_EXISTS
    test.cfg.transfer(nullifiers: [nullifier].span(), new_notes: [note].span());
    let result = test.cfg.safe_transfer(nullifiers: [nullifier].span(), new_notes: [note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NULLIFIER_ALREADY_EXISTS);

    // Catch ZERO_NOTE_ID
    let nullifier = test.new_nullifier();
    let mut zero_note = test.new_note_server(:amount);
    zero_note.id = Zero::zero();
    let result = test
        .cfg
        .safe_transfer(nullifiers: [nullifier].span(), new_notes: [zero_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_NOTE_ID);

    // Catch ZERO_ENC_NOTE_VALUE
    let nullifier = test.new_nullifier(); // New nullifier because of snforge revert storage bug.
    let mut zero_note = test.new_note_server(:amount);
    zero_note.enc_amount = Zero::zero();
    let result = test
        .cfg
        .safe_transfer(nullifiers: [nullifier].span(), new_notes: [zero_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ENC_NOTE_VALUE);

    // Catch NOTE_ALREADY_EXISTS
    let nullifier = test.new_nullifier(); // New nullifier because of snforge revert storage bug.
    let note = test.new_note_server(:amount); // New note because of snforge revert storage bug.
    token.supply(:user, :amount);
    user.deposit_server(:token, :amount, :note);
    let result = test.cfg.safe_transfer(nullifiers: [nullifier].span(), new_notes: [note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_ALREADY_EXISTS);
}

#[test]
fn test_withdraw() {
    let mut test: Test = Default::default();
    let token = test.new_token_server();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    let note = test.new_note_server(:amount);
    let recipient = test.new_user();
    let nullifier = test.new_nullifier();

    // Deposit tokens to the server.
    token.supply(:user, :amount);
    user.deposit_server(:token, :amount, :note);

    // Check balances before withdraw.
    assert_eq!(token.balance_of(address: test.cfg.address), amount.into());
    assert_eq!(token.balance_of(address: recipient.address), Zero::zero());
    assert_eq!(token.balance_of(address: user.address), Zero::zero());

    // Check storage before withdraw.
    assert_eq!(test.cfg.get_note(note_id: note.id), note.enc_amount);
    assert_eq!(test.cfg.nullifier_exists(:nullifier), false);

    // Recipient is not registered.
    assert_eq!(recipient.get_public_key(), Zero::zero());

    // Withdraw
    user.withdraw_server(recipient_addr: recipient.address, :token, :amount, :nullifier);

    // Check balances after withdraw.
    assert_eq!(token.balance_of(address: test.cfg.address), Zero::zero());
    assert_eq!(token.balance_of(address: recipient.address), amount.into());
    assert_eq!(token.balance_of(address: user.address), Zero::zero());

    // Check storage after withdraw.
    assert_eq!(test.cfg.get_note(note_id: note.id), note.enc_amount);
    assert_eq!(test.cfg.nullifier_exists(:nullifier), true);

    // Recipient is not registered.
    assert_eq!(recipient.get_public_key(), Zero::zero());
    // TODO: Test user balance in contract.
}

#[test]
#[feature("safe_dispatcher")]
fn test_withdraw_assertions() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let recipient = test.new_user();
    let token = test.new_token_server();
    let zero_token = Token::Custom(
        CustomToken { contract_address: Zero::zero(), balances_variable_selector: Zero::zero() },
    );
    let amount = constants::DEFAULT_AMOUNT;
    let note = test.new_note_server(:amount);
    let nullifier = test.new_nullifier();

    // Catch ZERO_RECIPIENT_ADDR
    let result = user
        .safe_withdraw_server(recipient_addr: Zero::zero(), :token, :amount, :nullifier);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_TOKEN
    let result = user
        .safe_withdraw_server(
            recipient_addr: recipient.address, token: zero_token, :amount, :nullifier,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT
    let result = user
        .safe_withdraw_server(
            recipient_addr: recipient.address, :token, amount: Zero::zero(), :nullifier,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);

    // Catch ZERO_NULLIFIER
    let result = user
        .safe_withdraw_server(
            recipient_addr: recipient.address, :token, :amount, nullifier: Zero::zero(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_NULLIFIER);

    // Catch NULLIFIER_ALREADY_EXISTS
    token.supply(:user, :amount);
    user.deposit_server(:token, :amount, :note);
    user.withdraw_server(recipient_addr: recipient.address, :token, :amount, :nullifier);
    let result = user
        .safe_withdraw_server(recipient_addr: recipient.address, :token, :amount, :nullifier);
    assert_panic_with_felt_error(:result, expected_error: errors::NULLIFIER_ALREADY_EXISTS);
}

