use core::num::traits::{Bounded, Zero};
use privacy::errors;
use privacy::objects::domain_separation::enc_channel_info;
use privacy::objects::{NewNote, NotePath, ServerAction};
use privacy::tests::test_utils::{
    PrivacyCfgTrait, Test, TestTrait, UserTrait, decrypt_channel_info, decrypt_subchannel_token,
};
use privacy::utils::{
    compute_enc_amount_hash, compute_note_id, compute_nullifier, compute_subchannel_key,
    decrypt_note_amount, encrypt_channel_info, is_canonical_key,
};
use snforge_std::map_entry_address;
use starkware_utils_testing::test_utils::{assert_panic_with_error, assert_panic_with_felt_error};

#[test]
fn test_register() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let public_key = user.public_key;
    let actions = user.register();

    let storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let expected_actions = array![ServerAction::WriteIfZero((storage_path_felt, public_key))]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
#[feature("safe_dispatcher")]
fn test_register_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();

    // Catch ZERO_PUBLIC_KEY.
    let mut user_zero_public_key = user;
    user_zero_public_key.public_key = Zero::zero();
    let result = user_zero_public_key.safe_register();
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PUBLIC_KEY);

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_register();
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
}

#[test]
fn test_transfer() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    user_1.open_channel_e2e(recipient: user_1, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_1, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);

    let note_path = NotePath { channel_index: 0, token, note_index };
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);
    let actions = user_1.transfer(notes_to_use: [note_path].span(), notes_to_create: [note].span());

    let expected_nullifier = user_1.compute_nullifier(sender: user_1, :token, :note_index);
    let enc_note = user_1.compute_enc_note(recipient: user_2, :token, index: note_index, :amount);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let storage_path_felt_note = map_entry_address(
        map_selector: selector!("notes"), keys: [enc_note.id].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero((storage_path_felt_nullifier, true.into())),
        ServerAction::WriteIfZero((storage_path_felt_note, enc_note.enc_amount)),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_transfer_to_self() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_1, :token);
    user_2.open_channel_e2e(recipient: user_1, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_2.new_note(recipient: user_1, :token, :amount, index: note_index);
    user_2.cheat_create_note_e2e(:note);

    let note_path = NotePath { channel_index: 1, token, note_index };
    let note = user_1.new_note(recipient: user_1, :token, :amount, index: note_index);

    let actions = user_1.transfer(notes_to_use: [note_path].span(), notes_to_create: [note].span());
    let expected_nullifier = user_1.compute_nullifier(sender: user_2, :token, :note_index);
    let enc_note = user_1.compute_enc_note(recipient: user_1, :token, index: note_index, :amount);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let storage_path_felt_note = map_entry_address(
        map_selector: selector!("notes"), keys: [enc_note.id].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero((storage_path_felt_nullifier, true.into())),
        ServerAction::WriteIfZero((storage_path_felt_note, enc_note.enc_amount)),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_transfer_one_to_many() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let user_3 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    user_3.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    user_1.open_channel_e2e(recipient: user_3, :token);
    user_1.open_channel_e2e(recipient: user_1, :token);
    let note_index = 0;
    let amount_1 = 1;
    let amount_2 = 8;
    let note = user_1
        .new_note(recipient: user_1, :token, amount: amount_1 + amount_2, index: note_index);
    user_1.cheat_create_note_e2e(:note);

    let note_path = NotePath { channel_index: 0, token, note_index };
    let note_1 = user_1.new_note(recipient: user_2, :token, amount: amount_1, index: note_index);
    let note_2 = user_1.new_note(recipient: user_3, :token, amount: amount_2, index: note_index);

    let actions = user_1
        .transfer(notes_to_use: [note_path].span(), notes_to_create: [note_1, note_2].span());
    let expected_nullifier = user_1.compute_nullifier(sender: user_1, :token, :note_index);
    let enc_note_1 = user_1
        .compute_enc_note(recipient: user_2, :token, index: note_index, amount: amount_1);
    let enc_note_2 = user_1
        .compute_enc_note(recipient: user_3, :token, index: note_index, amount: amount_2);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let storage_path_felt_note_1 = map_entry_address(
        map_selector: selector!("notes"), keys: [enc_note_1.id].span(),
    );
    let storage_path_felt_note_2 = map_entry_address(
        map_selector: selector!("notes"), keys: [enc_note_2.id].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero((storage_path_felt_nullifier, true.into())),
        ServerAction::WriteIfZero((storage_path_felt_note_1, enc_note_1.enc_amount)),
        ServerAction::WriteIfZero((storage_path_felt_note_2, enc_note_2.enc_amount)),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_transfer_many_to_one() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let token = test.mock_new_token();
    user_1.register_e2e();
    user_2.register_e2e();
    user_3.register_e2e();
    user_1.open_channel_e2e(recipient: user_2, :token);
    user_2.open_channel_e2e(recipient: user_1, :token);
    user_3.open_channel_e2e(recipient: user_1, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_2.new_note(recipient: user_1, :token, :amount, index: note_index);
    user_2.cheat_create_note_e2e(:note);
    let note = user_3.new_note(recipient: user_1, :token, :amount, index: note_index);
    user_3.cheat_create_note_e2e(:note);

    let note_path_1 = NotePath { channel_index: 0, token, note_index: 0 };
    let note_path_2 = NotePath { channel_index: 1, token, note_index: 0 };
    let amount = 2 * amount;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);

    let actions = user_1
        .transfer(notes_to_use: [note_path_1, note_path_2].span(), notes_to_create: [note].span());

    // Test use_note output.
    let expected_nullifier_1 = user_1.compute_nullifier(sender: user_2, :token, :note_index);
    let expected_nullifier_2 = user_1.compute_nullifier(sender: user_3, :token, :note_index);
    assert_ne!(expected_nullifier_1, expected_nullifier_2);
    let enc_note = user_1.compute_enc_note(recipient: user_2, :token, index: note_index, :amount);
    let storage_path_felt_nullifier_1 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_1].span(),
    );
    let storage_path_felt_nullifier_2 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_2].span(),
    );
    let storage_path_felt_note = map_entry_address(
        map_selector: selector!("notes"), keys: [enc_note.id].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero((storage_path_felt_nullifier_1, true.into())),
        ServerAction::WriteIfZero((storage_path_felt_nullifier_2, true.into())),
        ServerAction::WriteIfZero((storage_path_felt_note, enc_note.enc_amount)),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_transfer_many_to_many() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let token = test.mock_new_token();
    user_1.register_e2e();
    user_2.register_e2e();
    user_3.register_e2e();
    user_1.open_channel_e2e(recipient: user_3, :token);
    user_2.open_channel_e2e(recipient: user_3, :token);
    user_3.open_channel_e2e(recipient: user_1, :token);
    user_3.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_3, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let note = user_2.new_note(recipient: user_3, :token, :amount, index: note_index);
    user_2.cheat_create_note_e2e(:note);

    let note_path_1 = NotePath { channel_index: 0, token, note_index: 0 };
    let note_path_2 = NotePath { channel_index: 1, token, note_index: 0 };
    let note_1 = user_3.new_note(recipient: user_1, :token, :amount, index: note_index);
    let note_2 = user_3.new_note(recipient: user_2, :token, :amount, index: note_index);

    let actions = user_3
        .transfer(
            notes_to_use: [note_path_1, note_path_2].span(),
            notes_to_create: [note_1, note_2].span(),
        );

    let expected_nullifier_1 = user_3.compute_nullifier(sender: user_1, :token, :note_index);
    let expected_nullifier_2 = user_3.compute_nullifier(sender: user_2, :token, :note_index);
    assert_ne!(expected_nullifier_1, expected_nullifier_2);
    let enc_note_1 = user_3.compute_enc_note(recipient: user_1, :token, index: note_index, :amount);
    let enc_note_2 = user_3.compute_enc_note(recipient: user_2, :token, index: note_index, :amount);
    assert_ne!(enc_note_1.id, enc_note_2.id);
    assert_ne!(enc_note_1.enc_amount, enc_note_2.enc_amount);
    let storage_path_felt_nullifier_1 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_1].span(),
    );
    let storage_path_felt_nullifier_2 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_2].span(),
    );
    let storage_path_felt_note_1 = map_entry_address(
        map_selector: selector!("notes"), keys: [enc_note_1.id].span(),
    );
    let storage_path_felt_note_2 = map_entry_address(
        map_selector: selector!("notes"), keys: [enc_note_2.id].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero((storage_path_felt_nullifier_1, true.into())),
        ServerAction::WriteIfZero((storage_path_felt_nullifier_2, true.into())),
        ServerAction::WriteIfZero((storage_path_felt_note_1, enc_note_1.enc_amount)),
        ServerAction::WriteIfZero((storage_path_felt_note_2, enc_note_2.enc_amount)),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
#[feature("safe_dispatcher")]
fn test_transfer_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.mock_new_token();

    let note_path = NotePath { channel_index: 0, token, note_index: 0 };
    let new_note = NewNote { recipient_addr: user_2.address, token, amount: 1, index: 0 };

    // Catch ZERO_OWNER_ADDR.
    let mut user_1_zero = user_1;
    user_1_zero.address = Zero::zero();
    let result = user_1_zero
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OWNER_ADDR);

    // Catch ZERO_OWNER_PRIVATE_KEY.
    let mut user_1_zero_private_key = user_1;
    user_1_zero_private_key.private_key = Zero::zero();
    let result = user_1_zero_private_key
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OWNER_PRIVATE_KEY);

    // Catch NO_NOTES_TO_USE.
    let result = user_1.safe_transfer(notes_to_use: [].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_NOTES_TO_USE);

    // Catch NO_NOTES_TO_CREATE.
    let result = user_1.safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_NOTES_TO_CREATE);

    // Use note errors.

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_transfer(
            notes_to_use: [NotePath { token: Zero::zero(), ..note_path }].span(),
            notes_to_create: [new_note].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch INDEX_OUT_OF_BOUNDS ("Index out of bounds").
    let result = user_1
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_error(:result, expected_error: "Index out of bounds");

    user_1.register_e2e();
    user_1.open_channel_e2e(recipient: user_1, :token);

    // Catch NOTE_NOT_FOUND.
    let result = user_1
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    let note = user_1.new_note(recipient: user_1, :token, amount: 1, index: 0);
    user_1.cheat_create_note_e2e(:note);

    // Create note errors.

    // Catch ZERO_RECIPIENT.
    let result = user_1
        .safe_transfer(
            notes_to_use: [note_path].span(),
            notes_to_create: [NewNote { recipient_addr: Zero::zero(), ..new_note }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_transfer(
            notes_to_use: [note_path].span(),
            notes_to_create: [NewNote { token: Zero::zero(), ..new_note }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT.
    let result = user_1
        .safe_transfer(
            notes_to_use: [note_path].span(),
            notes_to_create: [NewNote { amount: Zero::zero(), ..new_note }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);

    // Catch RECIPIENT_NOT_REGISTERED.
    let result = user_1
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::RECIPIENT_NOT_REGISTERED);

    user_2.register_e2e();

    // Catch CHANNEL_NOT_FOUND.
    let result = user_1
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::CHANNEL_NOT_FOUND);

    user_1.open_channel_e2e(recipient: user_2, :token);

    // Catch INDEX_NOT_SEQUENTIAL.
    let result = user_1
        .safe_transfer(
            notes_to_use: [note_path].span(),
            notes_to_create: [NewNote { index: 1, ..new_note }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);

    // Transfer errors.

    // Catch NOTE_SUM_MISMATCH.
    let result = user_1
        .safe_transfer(
            notes_to_use: [note_path].span(),
            notes_to_create: [NewNote { amount: 2, ..new_note }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_SUM_MISMATCH);
}

#[test]
fn test_open_channel() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();

    let (random, channel_output) = user_1
        .open_channel_with_generated_random(recipient: user_2, :token);
    let channel_key = user_1.compute_channel_key(recipient: user_2, :token);
    // TODO: Is it ok for tests to reuse the same util function as the contract?
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random,
        recipient_public_key: user_2.public_key,
        :channel_key,
        :token,
        sender_addr: user_1.address,
    );
    let expected_channel_id = user_1.compute_channel_id(recipient: user_2, :token);
    let public_key_storage_path = map_entry_address(
        map_selector: selector!("public_key"), keys: [user_2.address.into()].span(),
    );
    let channel_exists_storage_path = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_id].span(),
    );
    let expected_actions = array![
        ServerAction::VerifyValue((public_key_storage_path, user_2.public_key)),
        ServerAction::WriteIfZero((channel_exists_storage_path, true.into())),
        ServerAction::AppendToVec((user_2.address, user_2.public_key, expected_enc_channel_info)),
    ]
        .span();
    assert_eq!(channel_output, expected_actions);
}

#[test]
fn test_open_channel_self_channel() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.register_e2e();
    let token = test.mock_new_token();

    let (random, channel_output) = user.open_channel_with_generated_random(recipient: user, :token);
    let channel_key = user.compute_channel_key(recipient: user, :token);
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random,
        recipient_public_key: user.public_key,
        :channel_key,
        :token,
        sender_addr: user.address,
    );
    let expected_channel_id = user.compute_channel_id(recipient: user, :token);
    let public_key_storage_path = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let channel_exists_storage_path = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_id].span(),
    );
    let expected_actions = array![
        ServerAction::VerifyValue((public_key_storage_path, user.public_key)),
        ServerAction::WriteIfZero((channel_exists_storage_path, true.into())),
        ServerAction::AppendToVec((user.address, user.public_key, expected_enc_channel_info)),
    ]
        .span();
    assert_eq!(channel_output, expected_actions);
}

#[test]
#[feature("safe_dispatcher")]
fn test_open_channel_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.mock_new_token();
    let random = user_1.get_random();

    // Catch ZERO_SENDER_ADDR.
    let mut user_zero_addr = user_1;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_open_channel(recipient: user_2, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SENDER_ADDR);

    // Catch ZERO_SENDER_PRIVATE_KEY.
    let mut user_zero_private_key = user_1;
    user_zero_private_key.private_key = Zero::zero();
    let result = user_zero_private_key.safe_open_channel(recipient: user_2, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SENDER_PRIVATE_KEY);

    // Catch ZERO_RECIPIENT_ADDR.
    let mut user_zero_addr = user_2;
    user_zero_addr.address = Zero::zero();
    let result = user_1.safe_open_channel(recipient: user_zero_addr, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_TOKEN.
    let result = user_1.safe_open_channel(recipient: user_2, token: Zero::zero(), :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_RANDOM.
    let result = user_1.safe_open_channel(recipient: user_2, :token, random: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_invalid_private_key = user_1;
    user_invalid_private_key.private_key = Neg::neg(user_invalid_private_key.private_key);
    let result = user_invalid_private_key.safe_open_channel(recipient: user_2, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch SENDER_NOT_REGISTERED.
    let result = user_1.safe_open_channel(recipient: user_2, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::SENDER_NOT_REGISTERED);

    // Catch SENDER_NOT_AUTHENTICATED.
    user_1.register_e2e();
    let user_1_private_key = user_1.private_key;
    user_1.private_key = user_1.public_key;
    if !is_canonical_key(key: user_1.private_key) {
        user_1.private_key = Neg::neg(user_1.private_key);
    }
    let result = user_1.safe_open_channel(recipient: user_2, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::SENDER_NOT_AUTHENTICATED);
    user_1.private_key = user_1_private_key;

    // Catch RECIPIENT_NOT_REGISTERED - recipient not registered.
    let result = user_1.safe_open_channel(recipient: user_2, :token, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::RECIPIENT_NOT_REGISTERED);
}

#[test]
fn test_open_channel_multiple_channels_same_sender() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let user_3 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    user_3.register_e2e();
    let token = test.mock_new_token();

    let (random_1, c1_output) = user_1
        .open_channel_with_generated_random(recipient: user_2, :token);
    let (random_2, c2_output) = user_1
        .open_channel_with_generated_random(recipient: user_3, :token);
    let channel_key_1 = user_1.compute_channel_key(recipient: user_2, :token);
    let channel_key_2 = user_1.compute_channel_key(recipient: user_3, :token);
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
    let expected_channel_id_1 = user_1.compute_channel_id(recipient: user_2, :token);
    let expected_channel_id_2 = user_1.compute_channel_id(recipient: user_3, :token);
    assert_ne!(expected_channel_id_1, expected_channel_id_2);
    let public_key_storage_path_1 = map_entry_address(
        map_selector: selector!("public_key"), keys: [user_2.address.into()].span(),
    );
    let public_key_storage_path_2 = map_entry_address(
        map_selector: selector!("public_key"), keys: [user_3.address.into()].span(),
    );
    let channel_exists_storage_path_1 = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_id_1].span(),
    );
    let channel_exists_storage_path_2 = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_id_2].span(),
    );
    let expected_actions_1 = array![
        ServerAction::VerifyValue((public_key_storage_path_1, user_2.public_key)),
        ServerAction::WriteIfZero((channel_exists_storage_path_1, true.into())),
        ServerAction::AppendToVec((user_2.address, user_2.public_key, expected_enc_channel_info_1)),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::VerifyValue((public_key_storage_path_2, user_3.public_key)),
        ServerAction::WriteIfZero((channel_exists_storage_path_2, true.into())),
        ServerAction::AppendToVec((user_3.address, user_3.public_key, expected_enc_channel_info_2)),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);
}


#[test]
fn test_open_channel_multiple_channels_same_recipient() {
    let mut test = Default::default();
    let user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    user_3.register_e2e();
    let token = test.mock_new_token();

    let (random_1, c1_output) = user_2
        .open_channel_with_generated_random(recipient: user_1, :token);
    let (random_2, c2_output) = user_3
        .open_channel_with_generated_random(recipient: user_1, :token);
    let channel_key_1 = user_2.compute_channel_key(recipient: user_1, :token);
    let channel_key_2 = user_3.compute_channel_key(recipient: user_1, :token);
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
    let expected_channel_id_1 = user_2.compute_channel_id(recipient: user_1, :token);
    let expected_channel_id_2 = user_3.compute_channel_id(recipient: user_1, :token);
    assert_ne!(expected_channel_id_1, expected_channel_id_2);
    let public_key_storage_path_1 = map_entry_address(
        map_selector: selector!("public_key"), keys: [user_1.address.into()].span(),
    );
    let public_key_storage_path_2 = map_entry_address(
        map_selector: selector!("public_key"), keys: [user_1.address.into()].span(),
    );
    let channel_exists_storage_path_1 = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_id_1].span(),
    );
    let channel_exists_storage_path_2 = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_id_2].span(),
    );
    let expected_actions_1 = array![
        ServerAction::VerifyValue((public_key_storage_path_1, user_1.public_key)),
        ServerAction::WriteIfZero((channel_exists_storage_path_1, true.into())),
        ServerAction::AppendToVec((user_1.address, user_1.public_key, expected_enc_channel_info_1)),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::VerifyValue((public_key_storage_path_2, user_1.public_key)),
        ServerAction::WriteIfZero((channel_exists_storage_path_2, true.into())),
        ServerAction::AppendToVec((user_1.address, user_1.public_key, expected_enc_channel_info_2)),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);
}

#[test]
fn test_open_channel_multiple_tokens() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token_1 = test.mock_new_token();
    let token_2 = test.mock_new_token();

    let (random_1, c1_output) = user_1
        .open_channel_with_generated_random(recipient: user_2, token: token_1);
    let (random_2, c2_output) = user_1
        .open_channel_with_generated_random(recipient: user_2, token: token_2);
    let channel_key_1 = user_1.compute_channel_key(recipient: user_2, token: token_1);
    let channel_key_2 = user_1.compute_channel_key(recipient: user_2, token: token_2);
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
    let expected_channel_id_1 = user_1.compute_channel_id(recipient: user_2, token: token_1);
    let expected_channel_id_2 = user_1.compute_channel_id(recipient: user_2, token: token_2);
    assert_ne!(expected_channel_id_1, expected_channel_id_2);
    let public_key_storage_path_1 = map_entry_address(
        map_selector: selector!("public_key"), keys: [user_2.address.into()].span(),
    );
    let public_key_storage_path_2 = map_entry_address(
        map_selector: selector!("public_key"), keys: [user_2.address.into()].span(),
    );
    let channel_exists_storage_path_1 = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_id_1].span(),
    );
    let channel_exists_storage_path_2 = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_id_2].span(),
    );
    let expected_actions_1 = array![
        ServerAction::VerifyValue((public_key_storage_path_1, user_2.public_key)),
        ServerAction::WriteIfZero((channel_exists_storage_path_1, true.into())),
        ServerAction::AppendToVec((user_2.address, user_2.public_key, expected_enc_channel_info_1)),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::VerifyValue((public_key_storage_path_2, user_2.public_key)),
        ServerAction::WriteIfZero((channel_exists_storage_path_2, true.into())),
        ServerAction::AppendToVec((user_2.address, user_2.public_key, expected_enc_channel_info_2)),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);
}

#[test]
fn test_open_channel_self_channel_multiple_tokens() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.register_e2e();
    let token_1 = test.mock_new_token();
    let token_2 = test.mock_new_token();

    let (random_1, c1_output) = user
        .open_channel_with_generated_random(recipient: user, token: token_1);
    let (random_2, c2_output) = user
        .open_channel_with_generated_random(recipient: user, token: token_2);
    let channel_key_1 = user.compute_channel_key(recipient: user, token: token_1);
    let channel_key_2 = user.compute_channel_key(recipient: user, token: token_2);
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
    let expected_channel_id_1 = user.compute_channel_id(recipient: user, token: token_1);
    let expected_channel_id_2 = user.compute_channel_id(recipient: user, token: token_2);
    assert_ne!(expected_channel_id_1, expected_channel_id_2);
    let public_key_storage_path_1 = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let public_key_storage_path_2 = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let channel_exists_storage_path_1 = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_id_1].span(),
    );
    let channel_exists_storage_path_2 = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_id_2].span(),
    );
    let expected_actions_1 = array![
        ServerAction::VerifyValue((public_key_storage_path_1, user.public_key)),
        ServerAction::WriteIfZero((channel_exists_storage_path_1, true.into())),
        ServerAction::AppendToVec((user.address, user.public_key, expected_enc_channel_info_1)),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::VerifyValue((public_key_storage_path_2, user.public_key)),
        ServerAction::WriteIfZero((channel_exists_storage_path_2, true.into())),
        ServerAction::AppendToVec((user.address, user.public_key, expected_enc_channel_info_2)),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);
}
// TODO: Test open channels with same sender and same random.

// TODO: Consider move this test to common test file.
#[test]
fn test_open_channel_decrypt_channel_info() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);

    // User 2 should be able to decrypt the channel info.
    assert_eq!(user_2.get_num_of_channels(), 1);
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (decrypted_channel_key, decrypted_token, decrypted_sender_addr) = decrypt_channel_info(
        :enc_channel_info, private_key: user_2.private_key,
    );

    // Verify decrypted channel key.
    let expected_channel_key = user_1.compute_channel_key(recipient: user_2, :token);
    assert_eq!(decrypted_channel_key, expected_channel_key);

    // Verify decrypted token.
    assert_eq!(decrypted_token.try_into().unwrap(), token);

    // Verify decrypted sender address.
    assert_eq!(decrypted_sender_addr, user_1.address);
}

#[test]
fn test_open_subchannel() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);

    let (random, channel_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, :token, index: 0);
    let expected_subchannel_key = user_1
        .compute_subchannel_key(recipient: user_2, :token, index: 0);
    let expected_enc_subchannel_info = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token, :random);
    let expected_subchannel_id = user_1.compute_subchannel_id(recipient: user_2, :token);

    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt, expected_enc_subchannel_info),
        ),
    ]
        .span();
    assert_eq!(channel_output, expected_actions);
}

#[test]
fn test_open_subchannel_self_channel() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.register_e2e();
    let token = test.mock_new_token();
    user.open_channel_e2e(recipient: user, :token);

    let (random, channel_output) = user
        .open_subchannel_with_generated_random(recipient: user, :token, index: 0);
    let expected_subchannel_key = user.compute_subchannel_key(recipient: user, :token, index: 0);
    let expected_enc_subchannel_info = user
        .compute_enc_subchannel_info(recipient: user, :token, :random);
    let expected_subchannel_id = user.compute_subchannel_id(recipient: user, :token);

    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt, expected_enc_subchannel_info),
        ),
    ]
        .span();
    assert_eq!(channel_output, expected_actions);
}

#[test]
#[feature("safe_dispatcher")]
fn test_open_subchannel_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.mock_new_token();
    let random = user_1.get_random();
    let index = 0;

    // Catch ZERO_SENDER_ADDR.
    let mut user_zero_addr = user_1;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_open_subchannel(recipient: user_2, :token, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SENDER_ADDR);

    // Catch ZERO_RECIPIENT_ADDR.
    let mut user_zero_addr = user_2;
    user_zero_addr.address = Zero::zero();
    let result = user_1.safe_open_subchannel(recipient: user_zero_addr, :token, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_CHANNEL_KEY.
    let result = user_1
        .safe_open_subchannel_with_channel_key(
            recipient: user_2, :token, :index, :random, channel_key: Zero::zero(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_CHANNEL_KEY);

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_open_subchannel(recipient: user_2, token: Zero::zero(), :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_RANDOM.
    let result = user_1
        .safe_open_subchannel(recipient: user_2, :token, :index, random: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);

    // Catch RECIPIENT_NOT_REGISTERED.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::RECIPIENT_NOT_REGISTERED);

    user_2.register_e2e();

    // Catch INVALID_CHANNEL - sender is not registered.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    user_1.register_e2e();

    // Catch INVALID_CHANNEL - no channel exists for the given sender and recipient.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    user_1.open_channel_e2e(recipient: user_2, :token);
    let channel_key = user_1.compute_channel_key(recipient: user_2, :token);

    // Catch INVALID_CHANNEL - wrong sender_addr.
    let mut user_1_wrong_addr = user_1;
    user_1_wrong_addr.address = user_2.address;
    let result = user_1_wrong_addr.safe_open_subchannel(recipient: user_2, :token, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INVALID_CHANNEL - wrong recipient_addr.
    let mut user_2_wrong_addr = user_2;
    user_2_wrong_addr.address = user_1.address;
    let result = user_1.safe_open_subchannel(recipient: user_2_wrong_addr, :token, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INVALID_CHANNEL - wrong channel key.
    let result = user_1
        .safe_open_subchannel_with_channel_key(
            recipient: user_2, :token, :index, :random, channel_key: channel_key + 1,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INDEX_NOT_SEQUENTIAL.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token, index: index + 1, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);

    // Sanity check - should succeed.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token, :index, :random);
    assert_eq!(result.is_ok(), true);
}

// TODO: Add this test once token is removed from channel.
#[test]
#[ignore]
fn test_open_subchannel_multiple() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token_1 = test.mock_new_token();
    let token_2 = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, token: token_1);

    // Multiple subchannels with different tokens.
    let (random_1, c1_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, token: token_1, index: 0);
    let (random_2, c2_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, token: token_2, index: 1);
    let expected_subchannel_key_1 = user_1
        .compute_subchannel_key(recipient: user_2, token: token_1, index: 0);
    let expected_subchannel_key_2 = user_1
        .compute_subchannel_key(recipient: user_2, token: token_2, index: 1);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(recipient: user_2, token: token_1, random: random_1);
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(recipient: user_2, token: token_2, random: random_2);
    let expected_subchannel_id_1 = user_1.compute_subchannel_id(recipient: user_2, token: token_1);
    let expected_subchannel_id_2 = user_1.compute_subchannel_id(recipient: user_2, token: token_2);
    assert_ne!(expected_subchannel_key_1, expected_subchannel_key_2);
    assert_ne!(expected_enc_subchannel_info_1.random, expected_enc_subchannel_info_2.random);
    assert_ne!(expected_enc_subchannel_info_1.enc_token, expected_enc_subchannel_info_2.enc_token);
    assert_ne!(expected_subchannel_id_1, expected_subchannel_id_2);
    let subchannel_exists_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id_1].span(),
    );
    let subchannel_exists_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id_2].span(),
    );
    let subchannel_tokens_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key_1].span(),
    );
    let subchannel_tokens_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key_2].span(),
    );
    let expected_actions_1 = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt_1, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt_1, expected_enc_subchannel_info_1),
        ),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt_2, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt_2, expected_enc_subchannel_info_2),
        ),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);

    // Multiple subchannels with the same token (fails only on the server side).
    let token = test.mock_new_token();
    let (random_1, c1_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, :token, index: 0);
    let (random_2, c2_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, :token, index: 1);
    let expected_subchannel_key_1 = user_1
        .compute_subchannel_key(recipient: user_2, :token, index: 0);
    let expected_subchannel_key_2 = user_1
        .compute_subchannel_key(recipient: user_2, :token, index: 1);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token, random: random_1);
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token, random: random_2);
    let expected_subchannel_id_1 = user_1.compute_subchannel_id(recipient: user_2, :token);
    let expected_subchannel_id_2 = user_1.compute_subchannel_id(recipient: user_2, :token);
    assert_ne!(expected_subchannel_key_1, expected_subchannel_key_2);
    assert_ne!(expected_enc_subchannel_info_1.random, expected_enc_subchannel_info_2.random);
    assert_ne!(expected_enc_subchannel_info_1.enc_token, expected_enc_subchannel_info_2.enc_token);
    assert_ne!(expected_subchannel_id_1, expected_subchannel_id_2);
    let subchannel_exists_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id_1].span(),
    );
    let subchannel_exists_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id_2].span(),
    );
    let subchannel_tokens_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key_1].span(),
    );
    let subchannel_tokens_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key_2].span(),
    );
    let expected_actions_1 = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt_1, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt_1, expected_enc_subchannel_info_1),
        ),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt_2, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt_2, expected_enc_subchannel_info_2),
        ),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);

    // Multiple subchannels with the same index (fails only on the server side).
    let (random_1, c1_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, token: token_1, index: 0);
    let (random_2, c2_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, token: token_2, index: 0);
    let expected_subchannel_key_1 = user_1
        .compute_subchannel_key(recipient: user_2, token: token_1, index: 0);
    let expected_subchannel_key_2 = user_1
        .compute_subchannel_key(recipient: user_2, token: token_2, index: 0);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(recipient: user_2, token: token_1, random: random_1);
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(recipient: user_2, token: token_2, random: random_2);
    let expected_subchannel_id_1 = user_1.compute_subchannel_id(recipient: user_2, token: token_1);
    let expected_subchannel_id_2 = user_1.compute_subchannel_id(recipient: user_2, token: token_2);
    assert_ne!(expected_subchannel_key_1, expected_subchannel_key_2);
    assert_ne!(expected_enc_subchannel_info_1.random, expected_enc_subchannel_info_2.random);
    assert_ne!(expected_enc_subchannel_info_1.enc_token, expected_enc_subchannel_info_2.enc_token);
    assert_ne!(expected_subchannel_id_1, expected_subchannel_id_2);
    let subchannel_exists_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id_1].span(),
    );
    let subchannel_exists_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id_2].span(),
    );
    let subchannel_tokens_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key_1].span(),
    );
    let subchannel_tokens_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key_2].span(),
    );
    let expected_actions_1 = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt_1, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt_1, expected_enc_subchannel_info_1),
        ),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt_2, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt_2, expected_enc_subchannel_info_2),
        ),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);
}

// TODO: Add this test once token is removed from channel.
#[test]
#[ignore]
fn test_open_subchannel_multiple_self_channel() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.register_e2e();
    let token_1 = test.mock_new_token();
    let token_2 = test.mock_new_token();
    user.open_channel_e2e(recipient: user, token: token_1);

    // Multiple subchannels with different tokens.
    let (random_1, c1_output) = user
        .open_subchannel_with_generated_random(recipient: user, token: token_1, index: 0);
    let (random_2, c2_output) = user
        .open_subchannel_with_generated_random(recipient: user, token: token_2, index: 1);
    let expected_subchannel_key_1 = user
        .compute_subchannel_key(recipient: user, token: token_1, index: 0);
    let expected_subchannel_key_2 = user
        .compute_subchannel_key(recipient: user, token: token_2, index: 1);
    let expected_enc_subchannel_info_1 = user
        .compute_enc_subchannel_info(recipient: user, token: token_1, random: random_1);
    let expected_enc_subchannel_info_2 = user
        .compute_enc_subchannel_info(recipient: user, token: token_2, random: random_2);
    let expected_subchannel_id_1 = user.compute_subchannel_id(recipient: user, token: token_1);
    let expected_subchannel_id_2 = user.compute_subchannel_id(recipient: user, token: token_2);
    assert_ne!(expected_subchannel_key_1, expected_subchannel_key_2);
    assert_ne!(expected_enc_subchannel_info_1.random, expected_enc_subchannel_info_2.random);
    assert_ne!(expected_enc_subchannel_info_1.enc_token, expected_enc_subchannel_info_2.enc_token);
    assert_ne!(expected_subchannel_id_1, expected_subchannel_id_2);
    let subchannel_exists_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id_1].span(),
    );
    let subchannel_exists_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id_2].span(),
    );
    let subchannel_tokens_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key_1].span(),
    );
    let subchannel_tokens_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key_2].span(),
    );
    let expected_actions_1 = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt_1, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt_1, expected_enc_subchannel_info_1),
        ),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt_2, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt_2, expected_enc_subchannel_info_2),
        ),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);
}
// TODO: Test open subchannels with same random.

#[test]
fn test_open_subchannel_decrypt_subchannel_info() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    user_1.open_subchannel_e2e(recipient: user_2, :token, index: 0);

    // User 2 should be able to decrypt the subchannel info (the token).
    // User 2 decrypts the channel_key.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (decrypted_channel_key, _, _) = decrypt_channel_info(
        :enc_channel_info, private_key: user_2.private_key,
    );
    // User 2 decrypts the subchannel token.
    let subchannel_key = compute_subchannel_key(channel_key: decrypted_channel_key, index: 0);
    let enc_subchannel_info = test.privacy.get_subchannel_info(:subchannel_key);
    let decrypted_token = decrypt_subchannel_token(
        :enc_subchannel_info, channel_key: decrypted_channel_key,
    );
    assert_eq!(decrypted_token, token);
}

#[test]
fn test_create_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);
    let enc_note = user_1.create_note(:note);
    let expected_enc_note = user_1
        .compute_enc_note(recipient: user_2, :token, index: note_index, :amount);
    assert_eq!(enc_note, expected_enc_note);
}

#[test]
fn test_create_note_self_note() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.register_e2e();
    let token = test.mock_new_token();
    user.open_channel_e2e(recipient: user, :token);
    let amount = 1;
    let note_index = 0;
    let note = user.new_note(recipient: user, :token, :amount, index: note_index);
    let enc_note = user.create_note(:note);
    let expected_enc_note = user
        .compute_enc_note(recipient: user, :token, index: note_index, :amount);
    assert_eq!(enc_note, expected_enc_note);
}

#[test]
fn test_create_note_twice() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount_1 = 1;
    let note_index_1 = 0;
    let note_1 = user_1.new_note(recipient: user_2, :token, amount: amount_1, index: note_index_1);
    let enc_note_1 = user_1.create_note(note: note_1);
    let amount_2 = amount_1 + 1;
    let note_index_2 = note_index_1 + 1;
    user_1.privacy.cheat_create_note(note: enc_note_1);
    let note_2 = user_1.new_note(recipient: user_2, :token, amount: amount_2, index: note_index_2);
    let enc_note_2 = user_1.create_note(note: note_2);
    assert_ne!(enc_note_1.id, enc_note_2.id);
    assert_ne!(enc_note_1.enc_amount, enc_note_2.enc_amount);
    let expected_note_1 = user_1
        .compute_enc_note(recipient: user_2, :token, index: note_index_1, amount: amount_1);
    let expected_note_2 = user_1
        .compute_enc_note(recipient: user_2, :token, index: note_index_2, amount: amount_2);
    assert_eq!(enc_note_1, expected_note_1);
    assert_eq!(enc_note_2, expected_note_2);
}

#[test]
fn test_create_note_twice_same_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index_1 = 0;
    let note_1 = user_1.new_note(recipient: user_2, :token, :amount, index: note_index_1);
    let enc_note_1 = user_1.create_note(note: note_1);
    let note_index_2 = note_index_1 + 1;
    user_1.privacy.cheat_create_note(note: enc_note_1);
    let note_2 = user_1.new_note(recipient: user_2, :token, :amount, index: note_index_2);
    let enc_note_2 = user_1.create_note(note: note_2);
    assert_ne!(enc_note_1.id, enc_note_2.id);
    assert_ne!(enc_note_1.enc_amount, enc_note_2.enc_amount);
    let expected_note_1 = user_1
        .compute_enc_note(recipient: user_2, :token, index: note_index_1, :amount);
    let expected_note_2 = user_1
        .compute_enc_note(recipient: user_2, :token, index: note_index_2, :amount);
    assert_eq!(enc_note_1, expected_note_1);
    assert_eq!(enc_note_2, expected_note_2);
}

#[test]
#[should_panic(expected: 'ZERO_RECIPIENT_ADDR')]
fn test_create_note_zero_recipient_addr() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.mock_new_token();
    user_2.address = Zero::zero();
    let note = user_1.new_note(recipient: user_2, :token, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'ZERO_TOKEN')]
fn test_create_note_zero_token() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let note = user_1.new_note(recipient: user_2, token: Zero::zero(), amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'ZERO_AMOUNT')]
fn test_create_note_zero_amount() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.mock_new_token();
    let note = user_1.new_note(recipient: user_2, :token, amount: 0, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'RECIPIENT_NOT_REGISTERED')]
fn test_create_note_recipient_not_registered() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.mock_new_token();
    let note = user_1.new_note(recipient: user_2, :token, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'CHANNEL_NOT_FOUND')]
fn test_create_note_channel_not_found() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    let note = user_1.new_note(recipient: user_2, :token, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'INDEX_NOT_SEQUENTIAL')]
fn test_create_note_index_not_sequential() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
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
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);
    let enc_note = user_1.create_note(:note);
    user_1.privacy.cheat_create_note(note: enc_note);

    // User 2 should be able to decrypt the amount.
    // Decrypt channel key.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (channel_key, _, _) = decrypt_channel_info(
        :enc_channel_info, private_key: user_2.private_key,
    );
    let note_id = compute_note_id(:channel_key, :token, index: note_index);
    let enc_amount = user_2.privacy.get_note(:note_id);
    let decrypted_amount = decrypt_note_amount(
        enc_note_value: enc_amount, :channel_key, index: note_index,
    );
    assert_eq!(decrypted_amount, amount);
}

#[test]
fn test_deposit() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.mock_new_token();
    let amount = 100;

    // Setup user and note.
    user.register_e2e();
    user.open_channel_e2e(recipient: user, :token);
    let index = 0;
    let note = user.new_note(recipient: user, :token, :amount, :index);

    // Deposit.
    let actions = user.deposit(new_note: note);
    let enc_note_1 = user.compute_enc_note(recipient: user, :token, :index, :amount);
    let storage_path_felt_note = map_entry_address(
        map_selector: selector!("notes"), keys: [enc_note_1.id].span(),
    );
    let expected_actions = [
        ServerAction::WriteIfZero((storage_path_felt_note, enc_note_1.enc_amount)),
        ServerAction::TransferFrom((user.address, token, amount)),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Cheat server deposit.
    user.privacy.cheat_create_note(note: enc_note_1);

    // Deposit again (same token and amount).
    let index = 1;
    let note = NewNote { index, ..note };
    let actions = user.deposit(new_note: note);
    let enc_note_2 = user.compute_enc_note(recipient: user, :token, :index, :amount);
    let storage_path_felt_note = map_entry_address(
        map_selector: selector!("notes"), keys: [enc_note_2.id].span(),
    );
    let expected_actions = [
        ServerAction::WriteIfZero((storage_path_felt_note, enc_note_2.enc_amount)),
        ServerAction::TransferFrom((user.address, token, amount)),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Assert enc_notes are different.
    assert_ne!(enc_note_1.id, enc_note_2.id);
    assert_ne!(enc_note_1.enc_amount, enc_note_2.enc_amount);
}

#[test]
#[feature("safe_dispatcher")]
fn test_deposit_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.mock_new_token();
    let amount = 100;
    let note = user.new_note(recipient: user, :token, :amount, index: 0);

    // Catch ZERO_OWNER_PRIVATE_KEY.
    let mut user_zero_key = user;
    user_zero_key.private_key = Zero::zero();
    let result = user_zero_key.safe_deposit(new_note: note);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OWNER_PRIVATE_KEY);

    // Catch ZERO_RECIPIENT_ADDR.
    let result = user.safe_deposit(new_note: NewNote { recipient_addr: Zero::zero(), ..note });
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_TOKEN.
    let result = user.safe_deposit(new_note: NewNote { token: Zero::zero(), ..note });
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT.
    let result = user.safe_deposit(new_note: NewNote { amount: Zero::zero(), ..note });
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);

    // Catch RECIPIENT_NOT_REGISTERED.
    let result = user.safe_deposit(new_note: note);
    assert_panic_with_felt_error(:result, expected_error: errors::RECIPIENT_NOT_REGISTERED);

    // Catch CHANNEL_NOT_FOUND.
    user.register_e2e();
    let result = user.safe_deposit(new_note: note);
    assert_panic_with_felt_error(:result, expected_error: errors::CHANNEL_NOT_FOUND);

    // Catch INDEX_NOT_SEQUENTIAL.
    user.open_channel_e2e(recipient: user, :token);
    let result = user.safe_deposit(new_note: NewNote { index: 1, ..note });
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);
}

#[test]
fn test_use_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let note_path = NotePath { channel_index: 0, token, note_index };
    let (nullifier, note_amount) = user_2.use_note(note: note_path);
    assert_eq!(note_amount, amount);
    let expected_nullifier = user_2.compute_nullifier(sender: user_1, :token, :note_index);
    assert_eq!(nullifier, expected_nullifier);
}

#[test]
fn test_use_note_self_note() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.register_e2e();
    let token = test.mock_new_token();
    user.open_channel_e2e(recipient: user, :token);
    let amount = 1;
    let note_index = 0;
    let note = user.new_note(recipient: user, :token, :amount, index: note_index);
    user.cheat_create_note_e2e(:note);
    let note_path = NotePath { channel_index: 0, token, note_index };
    let (nullifier, note_amount) = user.use_note(note: note_path);
    assert_eq!(note_amount, amount);
    let expected_nullifier = user.compute_nullifier(sender: user, :token, :note_index);
    assert_eq!(nullifier, expected_nullifier);
}

#[test]
fn test_use_note_multiple_notes() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_2.open_channel_e2e(recipient: user_2, :token);
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount_1 = 1;
    let amount_2 = 2;
    let note_1 = user_1.new_note(recipient: user_2, :token, amount: amount_1, index: 0);
    let note_2 = user_1.new_note(recipient: user_2, :token, amount: amount_2, index: 1);
    let note_3 = user_2.new_note(recipient: user_2, :token, amount: amount_1, index: 0);
    user_1.cheat_create_note_e2e(note: note_1);
    user_1.cheat_create_note_e2e(note: note_2);
    user_2.cheat_create_note_e2e(note: note_3);
    let note_1_path = NotePath { channel_index: 1, token, note_index: 0 };
    let note_2_path = NotePath { channel_index: 1, token, note_index: 1 };
    let note_3_path = NotePath { channel_index: 0, token, note_index: 0 };
    let (nullifier_1, note_amount_1) = user_2.use_note(note: note_1_path);
    let (nullifier_2, note_amount_2) = user_2.use_note(note: note_2_path);
    let (nullifier_3, note_amount_3) = user_2.use_note(note: note_3_path);
    assert_eq!(note_amount_1, amount_1);
    assert_eq!(note_amount_2, amount_2);
    assert_eq!(note_amount_3, amount_1);
    assert_ne!(nullifier_1, nullifier_2);
    assert_ne!(nullifier_1, nullifier_3);
    assert_ne!(nullifier_2, nullifier_3);
    let expected_nullifier_1 = user_2.compute_nullifier(sender: user_1, :token, note_index: 0);
    let expected_nullifier_2 = user_2.compute_nullifier(sender: user_1, :token, note_index: 1);
    assert_eq!(nullifier_1, expected_nullifier_1);
    assert_eq!(nullifier_2, expected_nullifier_2);
    let expected_nullifier_3 = user_2.compute_nullifier(sender: user_2, :token, note_index: 0);
    assert_eq!(nullifier_3, expected_nullifier_3);
}

#[test]
fn test_use_note_same_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_1 = user_1.new_note(recipient: user_2, :token, :amount, index: 0);
    let note_2 = user_1.new_note(recipient: user_2, :token, :amount, index: 1);
    user_1.cheat_create_note_e2e(note: note_1);
    user_1.cheat_create_note_e2e(note: note_2);
    let note_path_1 = NotePath { channel_index: 0, token, note_index: 0 };
    let note_path_2 = NotePath { channel_index: 0, token, note_index: 1 };
    let (nullifier_1, note_amount_1) = user_2.use_note(note: note_path_1);
    let (nullifier_2, note_amount_2) = user_2.use_note(note: note_path_2);
    assert_eq!(note_amount_1, amount);
    assert_eq!(note_amount_2, amount);
    assert_ne!(nullifier_1, nullifier_2);
    let expected_nullifier_1 = user_2.compute_nullifier(sender: user_1, :token, note_index: 0);
    let expected_nullifier_2 = user_2.compute_nullifier(sender: user_1, :token, note_index: 1);
    assert_eq!(nullifier_1, expected_nullifier_1);
    assert_eq!(nullifier_2, expected_nullifier_2);
}

#[test]
#[should_panic(expected: 'ZERO_TOKEN')]
fn test_use_note_zero_token() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let note_path = NotePath { channel_index: 0, token: Zero::zero(), note_index: 0 };
    user_1.use_note(note: note_path);
}

#[test]
#[should_panic(expected: "Index out of bounds")]
fn test_use_note_index_out_of_bounds() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let token = test.mock_new_token();
    let note_path = NotePath { channel_index: 0, token, note_index: 0 };
    user_1.use_note(note: note_path);
}

#[test]
#[should_panic(expected: 'NOTE_NOT_FOUND')]
fn test_use_note_wrong_owner_addr() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let note = user_1.new_note(recipient: user_2, :token, amount: 1, index: 0);
    user_1.cheat_create_note_e2e(:note);
    let note_path = NotePath { channel_index: 0, token, note_index: 0 };
    user_2.address = test.new_user().address;
    user_2.register_e2e();
    user_1.open_channel_e2e(recipient: user_2, :token);
    user_2.use_note(note: note_path);
}

#[test]
#[should_panic(expected: 'NOTE_NOT_FOUND')]
fn test_use_note_wrong_owner_private_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let note_path = NotePath { channel_index: 0, token, note_index };
    user_2.replace_private_key(private_key: test.new_private_key());
    user_2.replace_public_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, :token);
    user_2.use_note(note: note_path);
}

#[test]
#[should_panic(expected: 'NOTE_NOT_FOUND')]
fn test_use_note_wrong_note_index() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let note_path = NotePath { channel_index: 0, token, note_index: note_index + 1 };
    user_2.use_note(note: note_path);
}

#[test]
#[should_panic(expected: 'NOTE_NOT_FOUND')]
fn test_use_note_wrong_channel_index() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    user_2.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let note_path = NotePath { channel_index: 1, token, note_index };
    user_2.use_note(note: note_path);
}

#[test]
#[should_panic(expected: 'NOTE_NOT_FOUND')]
fn test_use_note_wrong_token() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let wrong_token = test.mock_new_token();
    let note_path = NotePath { channel_index: 0, token: wrong_token, note_index };
    user_2.use_note(note: note_path);
}

// TODO: Consider move this test to common test file.
#[test]
fn test_use_note_find_nullifier() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_2, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);

    // User 2 should be able to find the nullifier.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (channel_key, _, _) = decrypt_channel_info(
        :enc_channel_info, private_key: user_2.private_key,
    );
    let expected_nullifier = compute_nullifier(
        :channel_key, :token, index: note_index, owner_private_key: user_2.private_key,
    );
    assert!(!user_2.privacy.nullifier_exists(nullifier: expected_nullifier));

    // User 2 uses the note.
    let note_path = NotePath { channel_index: 0, token, note_index };
    let (nullifier, note_amount) = user_2.use_note(note: note_path);
    assert_eq!(note_amount, amount);
    assert_eq!(nullifier, expected_nullifier);
    user_2.privacy.cheat_use_note(nullifier: expected_nullifier);

    assert!(user_2.privacy.nullifier_exists(nullifier: expected_nullifier));
}
// TODO: Test use note with all fields of note same but one field different, for each field - test
// nullifier are different.
// TODO: Test create note with all fields of note same but one field different, for each field -
// test note_ids (and maybe enc_amount) are different.

#[test]
fn test_withdraw() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    user_1.register_e2e();
    let token = test.mock_new_token();

    user_1.open_channel_e2e(recipient: user_1, :token);
    let amount = 1;
    let note_index = 0;
    let note = user_1.new_note(recipient: user_1, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);

    let note_to_withdraw = NotePath { channel_index: 0, token, note_index: 0 };
    let actions = user_1.withdraw(withdrawal_target: user_2.address, :note_to_withdraw);
    let expected_nullifier = user_1.compute_nullifier(sender: user_1, :token, :note_index);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let expected_actions = [
        ServerAction::WriteIfZero((storage_path_felt_nullifier, true.into())),
        ServerAction::TransferTo((user_2.address, token, amount)),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_withdraw_different_targets() {
    let mut test = Default::default();
    let token = test.mock_new_token();
    let amount = 100;

    // Setup users.
    let mut user_1 = test.new_user(); // Owner.
    let user_2 = test.new_user(); // Registered user.
    let user_3 = test.new_user(); // Not registered.
    user_1.register_e2e();
    user_2.register_e2e();
    user_1.open_channel_e2e(recipient: user_1, :token);

    // Setup note.
    let note_index = 0;
    let note = user_1.new_note(recipient: user_1, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let note_to_withdraw = NotePath { channel_index: 0, token, note_index };
    let nullifier = user_1.compute_nullifier(sender: user_1, :token, :note_index);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );

    // Withdraw note to self.
    let actions = user_1.withdraw(withdrawal_target: user_1.address, :note_to_withdraw);
    let expected_actions = [
        ServerAction::WriteIfZero((storage_path_felt_nullifier, true.into())),
        ServerAction::TransferTo((user_1.address, token, amount)),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Withdraw note to other registered user.
    let actions = user_1.withdraw(withdrawal_target: user_2.address, :note_to_withdraw);
    let expected_actions = [
        ServerAction::WriteIfZero((storage_path_felt_nullifier, true.into())),
        ServerAction::TransferTo((user_2.address, token, amount)),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Withdraw note to not registered user.
    let actions = user_1.withdraw(withdrawal_target: user_3.address, :note_to_withdraw);
    let expected_actions = [
        ServerAction::WriteIfZero((storage_path_felt_nullifier, true.into())),
        ServerAction::TransferTo((user_3.address, token, amount)),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_withdraw_note_from_other_user() {
    let mut test = Default::default();
    let token = test.mock_new_token();
    let amount = 100;

    // Setup users.
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    user_1.open_channel_e2e(recipient: user_2, :token);

    let note_index = 0;
    user_1
        .cheat_create_note_e2e(
            user_1.new_note(recipient: user_2, :token, :amount, index: note_index),
        );
    let expected_nullifier = user_2.compute_nullifier(sender: user_1, :token, :note_index);
    let actions = user_2
        .withdraw(
            withdrawal_target: user_2.address,
            note_to_withdraw: NotePath { channel_index: 0, token, note_index },
        );
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let expected_actions = [
        ServerAction::WriteIfZero((storage_path_felt_nullifier, true.into())),
        ServerAction::TransferTo((user_2.address, token, amount)),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
#[feature("safe_dispatcher")]
fn test_withdraw_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.mock_new_token();
    let note_to_withdraw = NotePath { channel_index: 0, token, note_index: 0 };

    // Catch ZERO_OWNER_ADDR.
    let mut user_1_zero = user_1;
    user_1_zero.address = Zero::zero();
    let result = user_1_zero.safe_withdraw(withdrawal_target: user_2.address, :note_to_withdraw);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OWNER_ADDR);

    // Catch ZERO_OWNER_PRIVATE_KEY.
    let mut user_1_zero_private_key = user_1;
    user_1_zero_private_key.private_key = Zero::zero();
    let result = user_1_zero_private_key
        .safe_withdraw(withdrawal_target: user_2.address, :note_to_withdraw);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OWNER_PRIVATE_KEY);

    // Catch ZERO_WITHDRAWAL_TARGET.
    let result = user_1.safe_withdraw(withdrawal_target: Zero::zero(), :note_to_withdraw);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_WITHDRAWAL_TARGET);

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_withdraw(
            withdrawal_target: user_2.address,
            note_to_withdraw: NotePath { token: Zero::zero(), ..note_to_withdraw },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch Index out of bounds (index too high).
    let result = user_1
        .safe_withdraw(
            withdrawal_target: user_2.address,
            note_to_withdraw: NotePath { channel_index: 1, ..note_to_withdraw },
        );
    assert_panic_with_error(:result, expected_error: "Index out of bounds");

    // Catch Index out of bounds (wrong address).
    let mut user_1_wrong_addr = user_1;
    user_1_wrong_addr.address = test.new_user().address;
    let result = user_1_wrong_addr
        .safe_withdraw(
            withdrawal_target: user_2.address,
            note_to_withdraw: NotePath { channel_index: 0, token, note_index: 0 },
        );
    assert_panic_with_error(:result, expected_error: "Index out of bounds");

    // Catch Index out of bounds (wrong private key).
    user_1.replace_private_key(private_key: test.new_private_key());
    let result = user_1
        .safe_withdraw(
            withdrawal_target: user_2.address,
            note_to_withdraw: NotePath { channel_index: 0, token, note_index: 0 },
        );
    assert_panic_with_error(:result, expected_error: "Index out of bounds");
}

#[test]
#[feature("safe_dispatcher")]
fn test_withdraw_note_not_found() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let user_3 = test.new_user();
    let token = test.mock_new_token();

    user_1.register_e2e();
    user_2.register_e2e();
    user_1.open_channel_e2e(recipient: user_1, :token); // User 1 Channel 0
    user_1.open_channel_e2e(recipient: user_2, :token); // User 2 Channel 0
    user_2.open_channel_e2e(recipient: user_2, :token); // User 2 Channel 1
    let note = user_1.new_note(recipient: user_2, :token, amount: 1, index: 0);
    user_1.cheat_create_note_e2e(:note);
    let note_to_withdraw = NotePath { channel_index: 0, token, note_index: 0 };

    // Catch NOTE_NOT_FOUND (wrong user address).
    let mut user_2_wrong_addr = user_2;
    user_2_wrong_addr.address = test.new_user().address;
    user_2_wrong_addr.register_e2e();
    user_1.open_channel_e2e(recipient: user_2_wrong_addr, :token);
    let result = user_2_wrong_addr
        .safe_withdraw(withdrawal_target: user_3.address, :note_to_withdraw);
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    // Catch NOTE_NOT_FOUND (wrong private key).
    let mut user_2_wrong_private_key = user_2;
    user_2_wrong_private_key.replace_private_key(private_key: test.new_user().private_key);
    user_2_wrong_private_key.replace_public_key_e2e();
    user_1.open_channel_e2e(recipient: user_2_wrong_private_key, :token);
    let result = user_2_wrong_private_key
        .safe_withdraw(withdrawal_target: user_3.address, :note_to_withdraw);
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    // Catch NOTE_NOT_FOUND (wrong channel index).
    let result = user_2
        .safe_withdraw(
            withdrawal_target: user_3.address,
            note_to_withdraw: NotePath { channel_index: 1, ..note_to_withdraw },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    // Catch NOTE_NOT_FOUND (wrong note index).
    let result = user_2
        .safe_withdraw(
            withdrawal_target: user_3.address,
            note_to_withdraw: NotePath { note_index: 1, ..note_to_withdraw },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    // Catch NOTE_NOT_FOUND (wrong token).
    let wrong_token = test.mock_new_token();
    let result = user_2
        .safe_withdraw(
            withdrawal_target: user_3.address,
            note_to_withdraw: NotePath { token: wrong_token, ..note_to_withdraw },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    // Sanity check - should succeed.
    let result = user_2.safe_withdraw(withdrawal_target: user_3.address, :note_to_withdraw);
    assert_eq!(result.is_ok(), true);
}

#[test]
fn test_replace_public_key() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let original_public_key = user.public_key;

    // Register the user first.
    user.register_e2e();
    assert_eq!(user.get_public_key(), original_public_key);

    // Replace the public key.
    user.new_public_key();
    let actions = user.replace_public_key();
    let storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let expected_actions = [ServerAction::WriteIfNonZero((storage_path_felt, user.public_key))]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_replace_public_key_sanity() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let original_public_key = user.public_key;

    // Register the user first.
    user.register_e2e();
    assert_eq!(user.get_public_key(), original_public_key);

    // Replace the public key first time.
    user.new_public_key();
    user.replace_public_key_e2e();
    assert_eq!(user.get_public_key(), user.public_key);

    // Replace the public key second time.
    user.new_public_key();
    user.replace_public_key_e2e();
    assert_eq!(user.get_public_key(), user.public_key);

    // Replace back to original public key.
    user.public_key = original_public_key;
    user.replace_public_key_e2e();
    assert_eq!(user.get_public_key(), original_public_key);
}

#[test]
fn test_replace_public_key_same_key() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let original_public_key = user.public_key;

    // Register the user first.
    user.register_e2e();
    assert_eq!(user.get_public_key(), original_public_key);

    // Replace with the same public key.
    user.replace_public_key_e2e();
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
    user1.register_e2e();
    user2.register_e2e();

    // Verify initial keys.
    assert_eq!(user1.get_public_key(), user1_original_key);
    assert_eq!(user2.get_public_key(), user2_public_key);

    // User1 replaces their public key to user2's public key.
    user1.public_key = user2_public_key;
    user1.replace_public_key_e2e();

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
    let mut user_zero_public_key = user;
    user_zero_public_key.public_key = Zero::zero();
    let result = user_zero_public_key.safe_replace_public_key();
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PUBLIC_KEY);

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_replace_public_key();
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
}

#[test]
fn test_decrypt_note_amount_wrap_around() {
    let enc_note_value: u256 = 1;
    let channel_key = 1;
    let index = 0;
    let max_u128: u256 = Bounded::<u128>::MAX.into();
    let hash: u256 = compute_enc_amount_hash(:channel_key, :index).into() % max_u128;

    // Assert wrap around scenario.
    assert_lt!(enc_note_value, hash);
    let decrypted_amount = decrypt_note_amount(
        enc_note_value: enc_note_value.try_into().unwrap(), :channel_key, index: index,
    );

    assert_eq!(decrypted_amount.into(), enc_note_value + max_u128 - hash);
}

#[test]
fn test_decrypt_note_amount_no_wrap_around() {
    let enc_note_value: u256 = Bounded::<u128>::MAX.into();
    let channel_key = 1;
    let index = 0;
    let max_u128: u256 = Bounded::<u128>::MAX.into();
    let hash: u256 = compute_enc_amount_hash(:channel_key, :index).into() % max_u128;

    // Assert no wrap around scenario.
    assert_gt!(enc_note_value, hash);
    let decrypted_amount = decrypt_note_amount(
        enc_note_value: enc_note_value.try_into().unwrap(), :channel_key, index: index,
    );

    assert_eq!(decrypted_amount.into(), enc_note_value - hash);
}
