use core::num::traits::Zero;
use privacy::errors;
use privacy::hashes::{compute_note_id, compute_nullifier, compute_subchannel_key};
use privacy::objects::{ClientAction, NewNote, NotePath, ServerAction};
use privacy::tests::utils_for_tests::{
    EncNoteTrait, PrivacyCfgTrait, Test, TestTrait, UserTrait, decrypt_channel_info,
    decrypt_private_key, decrypt_subchannel_token,
};
use privacy::utils::{TWO_POW_120, decrypt_note_amount, encrypt_channel_info, is_canonical_key};
use snforge_std::map_entry_address;
use starkware_utils_testing::test_utils::assert_panic_with_felt_error;

#[test]
fn test_register() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let public_key = user.public_key;
    let (random, actions) = user.register_with_generated_random();
    let enc_private_key = user.compute_enc_private_key(:random);

    let public_key_storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let enc_private_key_storage_path_felt = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [user.address.into()].span(),
    );
    let expected_actions = [
        ServerAction::WriteIfZero((public_key_storage_path_felt, public_key)),
        ServerAction::WriteIfZeroPrivateKey((enc_private_key_storage_path_felt, enc_private_key)),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
#[feature("safe_dispatcher")]
fn test_register_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let random = user.get_random().into();

    // Catch ZERO_PRIVATE_KEY.
    let mut user_zero_public_key = user;
    user_zero_public_key.private_key = Zero::zero();
    let result = user_zero_public_key.safe_register(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

    // Catch ZERO_RANDOM.
    let result = user.safe_register(random: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_key_not_canonical = user;
    user_key_not_canonical.private_key = Neg::neg(user.private_key);
    let result = user_key_not_canonical.safe_register(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_register(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
}

#[test]
fn test_register_decrypt_private_key() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.register_e2e();

    // Compliance should be able to decrypt the private key.
    let enc_private_key = user.get_enc_private_key();
    let decrypted_private_key = decrypt_private_key(
        :enc_private_key, compliance_private_key: test.compliance_private_key,
    );
    assert_eq!(decrypted_private_key, user.private_key);
}

#[test]
fn test_transfer() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    user_1.open_channel_with_token_e2e(recipient: user_1, :token, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(recipient: user_1, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_1);

    let note_path = NotePath { channel_key, token, note_index };
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: note_index);
    let actions = user_1.transfer(notes_to_use: [note_path].span(), notes_to_create: [note].span());

    let expected_nullifier = user_1.compute_nullifier(sender: user_1, :token, :note_index);
    let enc_note = user_1
        .compute_enc_note(
            recipient: user_2, :token, index: note_index, :amount, random: note.random,
        );
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
    user_1.open_channel_with_token_e2e(recipient: user_1, :token, subchannel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_1, :token, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_2
        .new_note_with_generated_random(recipient: user_1, :token, :amount, index: note_index);
    user_2.cheat_create_note_e2e(:note);
    let channel_key = user_2.compute_channel_key(recipient: user_1);

    let note_path = NotePath { channel_key, token, note_index };
    let note = user_1
        .new_note_with_generated_random(recipient: user_1, :token, :amount, index: note_index);

    let actions = user_1.transfer(notes_to_use: [note_path].span(), notes_to_create: [note].span());
    let expected_nullifier = user_1.compute_nullifier(sender: user_2, :token, :note_index);
    let enc_note = user_1
        .compute_enc_note(
            recipient: user_1, :token, index: note_index, :amount, random: note.random,
        );
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
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    user_3.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    user_1.open_channel_with_token_e2e(recipient: user_3, :token, subchannel_index: 0);
    user_1.open_channel_with_token_e2e(recipient: user_1, :token, subchannel_index: 0);
    let note_index = 0;
    let amount_1 = 1;
    let amount_2 = 8;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_1, :token, amount: amount_1 + amount_2, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_1);

    let note_path = NotePath { channel_key, token, note_index };
    let note_1 = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token, amount: amount_1, index: note_index,
        );
    let note_2 = user_1
        .new_note_with_generated_random(
            recipient: user_3, :token, amount: amount_2, index: note_index,
        );

    let actions = user_1
        .transfer(notes_to_use: [note_path].span(), notes_to_create: [note_1, note_2].span());
    let expected_nullifier = user_1.compute_nullifier(sender: user_1, :token, :note_index);
    let enc_note_1 = user_1
        .compute_enc_note(
            recipient: user_2, :token, index: note_index, amount: amount_1, random: note_1.random,
        );
    let enc_note_2 = user_1
        .compute_enc_note(
            recipient: user_3, :token, index: note_index, amount: amount_2, random: note_2.random,
        );
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
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_1, :token, subchannel_index: 0);
    user_3.open_channel_with_token_e2e(recipient: user_1, :token, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_2
        .new_note_with_generated_random(recipient: user_1, :token, :amount, index: note_index);
    user_2.cheat_create_note_e2e(:note);
    let channel_key_1 = user_2.compute_channel_key(recipient: user_1);
    let note = user_3
        .new_note_with_generated_random(recipient: user_1, :token, :amount, index: note_index);
    user_3.cheat_create_note_e2e(:note);
    let channel_key_2 = user_3.compute_channel_key(recipient: user_1);

    let note_path_1 = NotePath { channel_key: channel_key_1, token, note_index: 0 };
    let note_path_2 = NotePath { channel_key: channel_key_2, token, note_index: 0 };
    let amount = 2 * amount;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: note_index);

    let actions = user_1
        .transfer(notes_to_use: [note_path_1, note_path_2].span(), notes_to_create: [note].span());

    // Test use_note output.
    let expected_nullifier_1 = user_1.compute_nullifier(sender: user_2, :token, :note_index);
    let expected_nullifier_2 = user_1.compute_nullifier(sender: user_3, :token, :note_index);
    assert_ne!(expected_nullifier_1, expected_nullifier_2);
    let enc_note = user_1
        .compute_enc_note(
            recipient: user_2, :token, index: note_index, :amount, random: note.random,
        );
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
    user_1.open_channel_with_token_e2e(recipient: user_3, :token, subchannel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_3, :token, subchannel_index: 0);
    user_3.open_channel_with_token_e2e(recipient: user_1, :token, subchannel_index: 0);
    user_3.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(recipient: user_3, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let channel_key_1 = user_1.compute_channel_key(recipient: user_3);
    let note = user_2
        .new_note_with_generated_random(recipient: user_3, :token, :amount, index: note_index);
    user_2.cheat_create_note_e2e(:note);
    let channel_key_2 = user_2.compute_channel_key(recipient: user_3);

    let note_path_1 = NotePath { channel_key: channel_key_1, token, note_index: 0 };
    let note_path_2 = NotePath { channel_key: channel_key_2, token, note_index: 0 };
    let note_1 = user_3
        .new_note_with_generated_random(recipient: user_1, :token, :amount, index: note_index);
    let note_2 = user_3
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: note_index);

    let actions = user_3
        .transfer(
            notes_to_use: [note_path_1, note_path_2].span(),
            notes_to_create: [note_1, note_2].span(),
        );

    let expected_nullifier_1 = user_3.compute_nullifier(sender: user_1, :token, :note_index);
    let expected_nullifier_2 = user_3.compute_nullifier(sender: user_2, :token, :note_index);
    assert_ne!(expected_nullifier_1, expected_nullifier_2);
    let enc_note_1 = user_3
        .compute_enc_note(
            recipient: user_1, :token, index: note_index, :amount, random: note_1.random,
        );
    let enc_note_2 = user_3
        .compute_enc_note(
            recipient: user_2, :token, index: note_index, :amount, random: note_2.random,
        );
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
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let token = test.mock_new_token();
    let channel_key = user_1.compute_channel_key(recipient: user_1);

    let note_path = NotePath { channel_key, token, note_index: 0 };
    let new_note = NewNote {
        recipient_addr: user_3.address,
        recipient_public_key: user_3.public_key,
        token,
        amount: 1,
        index: 0,
        random: user_1.get_random(),
    };

    // Catch ZERO_USER_ADDR.
    let mut user_1_zero = user_1;
    user_1_zero.address = Zero::zero();
    let result = user_1_zero
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Use note errors.

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_transfer(
            notes_to_use: [NotePath { token: Zero::zero(), ..note_path }].span(),
            notes_to_create: [new_note].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_CHANNEL_KEY.
    let result = user_1
        .safe_transfer(
            notes_to_use: [NotePath { channel_key: Zero::zero(), ..note_path }].span(),
            notes_to_create: [new_note].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_CHANNEL_KEY);

    // Catch ZERO_OWNER_PRIVATE_KEY.
    let mut user_1_zero_owner_private_key = user_1;
    user_1_zero_owner_private_key.private_key = Zero::zero();
    let result = user_1_zero_owner_private_key
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OWNER_PRIVATE_KEY);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_1_private_key_not_canonical = user_1;
    user_1_private_key_not_canonical
        .private_key = Neg::neg(user_1_private_key_not_canonical.private_key);
    let result = user_1_private_key_not_canonical
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch INVALID_SUBCHANNEL - channel doesnt exist.
    let result = user_1
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SUBCHANNEL);

    user_1.register_e2e();
    user_1.open_channel_e2e(recipient: user_1);

    // Catch INVALID_SUBCHANNEL - subchannel doesnt exist.
    let result = user_1
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SUBCHANNEL);

    user_1.open_subchannel_e2e(recipient: user_1, :token, index: 0);

    // Catch INVALID_SUBCHANNEL - wrong address.
    user_2.register_e2e();
    user_1.open_channel_e2e(recipient: user_2);
    let mut user_1_wrong_addr = user_1;
    user_1_wrong_addr.address = user_2.address;
    let result = user_1_wrong_addr
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SUBCHANNEL);

    // Catch INVALID_SUBCHANNEL - wrong private key.
    let mut user_1_wrong_private_key = user_1;
    user_1_wrong_private_key.private_key = user_1.public_key;
    let result = user_1_wrong_private_key
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SUBCHANNEL);

    // Catch INVALID_SUBCHANNEL - wrong token.
    let wrong_token = test.mock_new_token();
    let result = user_1
        .safe_transfer(
            notes_to_use: [NotePath { token: wrong_token, ..note_path }].span(),
            notes_to_create: [new_note].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SUBCHANNEL);

    // Catch INVALID_SUBCHANNEL - wrong channel key.
    let wrong_channel_key = user_1.compute_channel_key(recipient: user_2);
    let result = user_1
        .safe_transfer(
            notes_to_use: [NotePath { channel_key: wrong_channel_key, ..note_path }].span(),
            notes_to_create: [new_note].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SUBCHANNEL);

    // Catch NOTE_NOT_FOUND.
    let result = user_1
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    let note = user_1
        .new_note_with_generated_random(recipient: user_1, :token, amount: 1, index: 0);
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

    // Catch ZERO_RECIPIENT_PUBLIC_KEY.
    let result = user_1
        .safe_transfer(
            notes_to_use: [note_path].span(),
            notes_to_create: [NewNote { recipient_public_key: Zero::zero(), ..new_note }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);

    // Catch ZERO_RANDOM.
    let result = user_1
        .safe_transfer(
            notes_to_use: [note_path].span(),
            notes_to_create: [NewNote { random: Zero::zero(), ..new_note }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);

    // Catch RANDOM_EXCEEDS_120_BITS.
    let result = user_1
        .safe_transfer(
            notes_to_use: [note_path].span(),
            notes_to_create: [NewNote { random: TWO_POW_120.try_into().unwrap(), ..new_note }]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::RANDOM_EXCEEDS_120_BITS);

    // Note: ZERO_OWNER_PRIVATE_KEY is already caught in use_note.
    // Note: PRIVATE_KEY_NOT_CANONICAL is already caught in use_note.

    user_3.register_e2e();

    // Catch INVALID_SUBCHANNEL - channel doesnt exist.
    let result = user_1
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SUBCHANNEL);

    user_1.open_channel_e2e(recipient: user_3);

    // Catch INVALID_SUBCHANNEL - subchannel doesnt exist.
    let result = user_1
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SUBCHANNEL);

    user_1.open_subchannel_e2e(recipient: user_3, :token, index: 0);

    // Catch INVALID_SUBCHANNEL - wrong public key.
    let result = user_1
        .safe_transfer(
            notes_to_use: [note_path].span(),
            notes_to_create: [NewNote { recipient_public_key: user_1.public_key, ..new_note }]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SUBCHANNEL);

    // Catch INVALID_SUBCHANNEL - wrong address.
    let mut user_1_wrong_addr = user_1;
    user_1_wrong_addr.address = user_2.address;
    let result = user_1_wrong_addr
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SUBCHANNEL);

    // Catch INVALID_SUBCHANNEL - wrong private key.
    let mut user_1_wrong_private_key = user_1;
    user_1_wrong_private_key.private_key = user_1.public_key;
    let result = user_1_wrong_private_key
        .safe_transfer(notes_to_use: [note_path].span(), notes_to_create: [new_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SUBCHANNEL);

    // Catch INVALID_SUBCHANNEL - wrong token.
    let wrong_token = test.mock_new_token();
    let result = user_1
        .safe_transfer(
            notes_to_use: [note_path].span(),
            notes_to_create: [NewNote { token: wrong_token, ..new_note }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SUBCHANNEL);

    // Catch INDEX_NOT_SEQUENTIAL.
    let result = user_1
        .safe_transfer(
            notes_to_use: [note_path].span(),
            notes_to_create: [NewNote { index: 1, ..new_note }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);
    // Transfer errors.

    // TODO: Catch token balances error.
}

#[test]
fn test_open_channel() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();

    let (random, channel_output) = user_1.open_channel_with_generated_random(recipient: user_2);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random,
        recipient_public_key: user_2.public_key,
        :channel_key,
        sender_addr: user_1.address,
    );
    let expected_channel_id = user_1.compute_channel_id(recipient: user_2);
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

    let (random, channel_output) = user.open_channel_with_generated_random(recipient: user);
    let channel_key = user.compute_channel_key(recipient: user);
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random,
        recipient_public_key: user.public_key,
        :channel_key,
        sender_addr: user.address,
    );
    let expected_channel_id = user.compute_channel_id(recipient: user);
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
    let random = user_1.get_random().into();

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user_1;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_open_channel(recipient: user_2, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch ZERO_SENDER_PRIVATE_KEY.
    let mut user_zero_private_key = user_1;
    user_zero_private_key.private_key = Zero::zero();
    let result = user_zero_private_key.safe_open_channel(recipient: user_2, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SENDER_PRIVATE_KEY);

    // Catch ZERO_RECIPIENT_ADDR.
    let mut user_zero_addr = user_2;
    user_zero_addr.address = Zero::zero();
    let result = user_1.safe_open_channel(recipient: user_zero_addr, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_RECIPIENT_PUBLIC_KEY.
    let mut user_zero_public_key = user_2;
    user_zero_public_key.public_key = Zero::zero();
    let result = user_1.safe_open_channel(recipient: user_zero_public_key, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);

    // Catch ZERO_RANDOM.
    let result = user_1.safe_open_channel(recipient: user_2, random: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_invalid_private_key = user_1;
    user_invalid_private_key.private_key = Neg::neg(user_invalid_private_key.private_key);
    let result = user_invalid_private_key.safe_open_channel(recipient: user_2, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch SENDER_NOT_REGISTERED.
    let result = user_1.safe_open_channel(recipient: user_2, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::SENDER_NOT_REGISTERED);

    // Catch SENDER_NOT_AUTHENTICATED.
    user_1.register_e2e();
    let user_1_private_key = user_1.private_key;
    user_1.private_key = user_1.public_key;
    if !is_canonical_key(key: user_1.private_key) {
        user_1.private_key = Neg::neg(user_1.private_key);
    }
    let result = user_1.safe_open_channel(recipient: user_2, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::SENDER_NOT_AUTHENTICATED);
    user_1.private_key = user_1_private_key;
}

#[test]
fn test_open_channel_multiple_channels_same_sender() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    user_3.register_e2e();

    let (random_1, c1_output) = user_1.open_channel_with_generated_random(recipient: user_2);
    let (random_2, c2_output) = user_1.open_channel_with_generated_random(recipient: user_3);
    let channel_key_1 = user_1.compute_channel_key(recipient: user_2);
    let channel_key_2 = user_1.compute_channel_key(recipient: user_3);
    assert_ne!(channel_key_1, channel_key_2);
    let expected_enc_channel_info_1 = encrypt_channel_info(
        ephemeral_secret: random_1,
        recipient_public_key: user_2.public_key,
        channel_key: channel_key_1,
        sender_addr: user_1.address,
    );
    let expected_enc_channel_info_2 = encrypt_channel_info(
        ephemeral_secret: random_2,
        recipient_public_key: user_3.public_key,
        channel_key: channel_key_2,
        sender_addr: user_1.address,
    );
    assert_ne!(
        expected_enc_channel_info_1.ephemeral_pubkey, expected_enc_channel_info_2.ephemeral_pubkey,
    );
    assert_ne!(
        expected_enc_channel_info_1.enc_channel_key, expected_enc_channel_info_2.enc_channel_key,
    );
    assert_ne!(
        expected_enc_channel_info_1.enc_sender_addr, expected_enc_channel_info_2.enc_sender_addr,
    );
    let expected_channel_id_1 = user_1.compute_channel_id(recipient: user_2);
    let expected_channel_id_2 = user_1.compute_channel_id(recipient: user_3);
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
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    user_3.register_e2e();

    let (random_1, c1_output) = user_2.open_channel_with_generated_random(recipient: user_1);
    let (random_2, c2_output) = user_3.open_channel_with_generated_random(recipient: user_1);
    let channel_key_1 = user_2.compute_channel_key(recipient: user_1);
    let channel_key_2 = user_3.compute_channel_key(recipient: user_1);
    assert_ne!(channel_key_1, channel_key_2);
    let expected_enc_channel_info_1 = encrypt_channel_info(
        ephemeral_secret: random_1,
        recipient_public_key: user_1.public_key,
        channel_key: channel_key_1,
        sender_addr: user_2.address,
    );
    let expected_enc_channel_info_2 = encrypt_channel_info(
        ephemeral_secret: random_2,
        recipient_public_key: user_1.public_key,
        channel_key: channel_key_2,
        sender_addr: user_3.address,
    );
    // The ephemeral public keys are identical (same recipient and both users use the same random).
    assert_eq!(
        expected_enc_channel_info_1.ephemeral_pubkey, expected_enc_channel_info_2.ephemeral_pubkey,
    );
    assert_ne!(
        expected_enc_channel_info_1.enc_channel_key, expected_enc_channel_info_2.enc_channel_key,
    );
    assert_ne!(
        expected_enc_channel_info_1.enc_sender_addr, expected_enc_channel_info_2.enc_sender_addr,
    );
    let expected_channel_id_1 = user_2.compute_channel_id(recipient: user_1);
    let expected_channel_id_2 = user_3.compute_channel_id(recipient: user_1);
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

// TODO: Test actions with same random.

#[test]
fn test_open_channel_decrypt_channel_info() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    user_1.open_channel_e2e(recipient: user_2);

    // User 2 should be able to decrypt the channel info.
    assert_eq!(user_2.get_num_of_channels(), 1);
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (decrypted_channel_key, decrypted_sender_addr) = decrypt_channel_info(
        :enc_channel_info, private_key: user_2.private_key,
    );

    // Verify decrypted channel key.
    let expected_channel_key = user_1.compute_channel_key(recipient: user_2);
    assert_eq!(decrypted_channel_key, expected_channel_key);

    // Verify decrypted sender address.
    assert_eq!(decrypted_sender_addr, user_1.address);
}

#[test]
fn test_open_subchannel() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2);

    let (random, channel_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, :token, index: 0);
    let expected_subchannel_key = user_1.compute_subchannel_key(recipient: user_2, index: 0);
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
    user.open_channel_e2e(recipient: user);

    let (random, channel_output) = user
        .open_subchannel_with_generated_random(recipient: user, :token, index: 0);
    let expected_subchannel_key = user.compute_subchannel_key(recipient: user, index: 0);
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
    let mut user_2 = test.new_user();
    let token = test.mock_new_token();
    let random = user_1.get_random().into();
    let index = 0;

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user_1;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_open_subchannel(recipient: user_2, :token, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

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

    // Catch ZERO_RECIPIENT_PUBLIC_KEY.
    let mut user_zero_public_key = user_2;
    user_zero_public_key.public_key = Zero::zero();
    let result = user_1
        .safe_open_subchannel(recipient: user_zero_public_key, :token, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);

    user_2.register_e2e();

    // Catch INVALID_CHANNEL - sender is not registered.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    user_1.register_e2e();

    // Catch INVALID_CHANNEL - no channel exists for the given sender and recipient.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    user_1.open_channel_e2e(recipient: user_2);
    let channel_key = user_1.compute_channel_key(recipient: user_2);

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

    // Catch INVALID_CHANNEL - wrong recipient_public_key.
    let mut user_2_wrong_public_key = user_2;
    user_2_wrong_public_key.public_key = user_1.public_key;
    let result = user_1
        .safe_open_subchannel(recipient: user_2_wrong_public_key, :token, :index, :random);
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

#[test]
fn test_open_subchannel_multiple() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    user_1.open_channel_e2e(recipient: user_2);
    let token_1 = test.mock_new_token();
    let token_2 = test.mock_new_token();

    // Multiple subchannels with different tokens.
    let (random_1, c1_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, token: token_1, index: 0);
    test.privacy.execute_actions(actions: c1_output);
    let (random_2, c2_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, token: token_2, index: 1);
    let expected_subchannel_key_1 = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_subchannel_key_2 = user_1.compute_subchannel_key(recipient: user_2, index: 1);
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
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    user_1.open_channel_e2e(recipient: user_2);
    let token = test.mock_new_token();
    let (random_1, c1_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, :token, index: 0);
    test.privacy.execute_actions(actions: c1_output);
    let (random_2, c2_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, :token, index: 1);
    let expected_subchannel_key_1 = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_subchannel_key_2 = user_1.compute_subchannel_key(recipient: user_2, index: 1);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token, random: random_1);
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token, random: random_2);
    // Id will be the same since the token is the same.
    let expected_subchannel_id = user_1.compute_subchannel_id(recipient: user_2, :token);
    assert_ne!(expected_subchannel_key_1, expected_subchannel_key_2);
    assert_ne!(expected_enc_subchannel_info_1.random, expected_enc_subchannel_info_2.random);
    assert_ne!(expected_enc_subchannel_info_1.enc_token, expected_enc_subchannel_info_2.enc_token);
    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id].span(),
    );
    let subchannel_tokens_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key_1].span(),
    );
    let subchannel_tokens_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key_2].span(),
    );
    let expected_actions_1 = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt_1, expected_enc_subchannel_info_1),
        ),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt_2, expected_enc_subchannel_info_2),
        ),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);

    // Multiple subchannels with the same index (fails only on the server side).
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    user_1.open_channel_e2e(recipient: user_2);
    let (random_1, c1_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, token: token_1, index: 0);
    test.privacy.execute_actions(actions: c1_output);
    let (random_2, c2_output) = user_1
        .open_subchannel_with_generated_random(recipient: user_2, token: token_2, index: 0);
    // Key will be the same since the index is the same.
    let expected_subchannel_key = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(recipient: user_2, token: token_1, random: random_1);
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(recipient: user_2, token: token_2, random: random_2);
    let expected_subchannel_id_1 = user_1.compute_subchannel_id(recipient: user_2, token: token_1);
    let expected_subchannel_id_2 = user_1.compute_subchannel_id(recipient: user_2, token: token_2);
    assert_ne!(expected_enc_subchannel_info_1.random, expected_enc_subchannel_info_2.random);
    assert_ne!(expected_enc_subchannel_info_1.enc_token, expected_enc_subchannel_info_2.enc_token);
    assert_ne!(expected_subchannel_id_1, expected_subchannel_id_2);
    let subchannel_exists_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id_1].span(),
    );
    let subchannel_exists_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id_2].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key].span(),
    );
    let expected_actions_1 = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt_1, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt, expected_enc_subchannel_info_1),
        ),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::WriteIfZero((subchannel_exists_storage_path_felt_2, true.into())),
        ServerAction::WriteIfZeroSubchannel(
            (subchannel_tokens_storage_path_felt, expected_enc_subchannel_info_2),
        ),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);
}

#[test]
fn test_open_subchannel_multiple_self_channel() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.register_e2e();
    let token_1 = test.mock_new_token();
    let token_2 = test.mock_new_token();
    user.open_channel_e2e(recipient: user);

    // Multiple subchannels with different tokens.
    let (random_1, c1_output) = user
        .open_subchannel_with_generated_random(recipient: user, token: token_1, index: 0);
    test.privacy.execute_actions(actions: c1_output);
    let (random_2, c2_output) = user
        .open_subchannel_with_generated_random(recipient: user, token: token_2, index: 1);
    let expected_subchannel_key_1 = user.compute_subchannel_key(recipient: user, index: 0);
    let expected_subchannel_key_2 = user.compute_subchannel_key(recipient: user, index: 1);
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

#[test]
fn test_open_subchannel_decrypt_subchannel_info() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2);
    user_1.open_subchannel_e2e(recipient: user_2, :token, index: 0);

    // User 2 should be able to decrypt the subchannel info (the token).
    // User 2 decrypts the channel_key.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (decrypted_channel_key, _) = decrypt_channel_info(
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
fn test_create_note_self_note() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.register_e2e();
    let token = test.mock_new_token();
    user.open_channel_with_token_e2e(recipient: user, :token, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user
        .new_note_with_generated_random(recipient: user, :token, :amount, index: note_index);
    let actions = user.create_note(:note);
    let expected_enc_note = user
        .compute_enc_note(recipient: user, :token, index: note_index, :amount, random: note.random);
    assert_eq!(actions, expected_enc_note.to_server_actions());
}

#[test]
fn test_create_note_twice() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let amount_1 = 1;
    let note_index_1 = 0;
    let note_1 = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token, amount: amount_1, index: note_index_1,
        );
    let create_note_1_actions = user_1.create_note(note: note_1);
    let amount_2 = amount_1 + 1;
    let note_index_2 = note_index_1 + 1;
    user_1.privacy.execute_actions(actions: create_note_1_actions);
    let note_2 = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token, amount: amount_2, index: note_index_2,
        );
    let create_note_2_actions = user_1.create_note(note: note_2);
    let expected_note_1 = user_1
        .compute_enc_note(
            recipient: user_2, :token, index: note_index_1, amount: amount_1, random: note_1.random,
        );
    let expected_note_2 = user_1
        .compute_enc_note(
            recipient: user_2, :token, index: note_index_2, amount: amount_2, random: note_2.random,
        );
    assert_ne!(expected_note_1.id, expected_note_2.id);
    assert_ne!(expected_note_1.enc_amount, expected_note_2.enc_amount);
    assert_eq!(create_note_1_actions, expected_note_1.to_server_actions());
    assert_eq!(create_note_2_actions, expected_note_2.to_server_actions());
}

#[test]
fn test_create_note_twice_same_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let amount = 1;
    let note_index_1 = 0;
    let note_1 = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: note_index_1);
    let create_note_1_actions = user_1.create_note(note: note_1);
    let note_index_2 = note_index_1 + 1;
    test.privacy.execute_actions(actions: create_note_1_actions);
    let note_2 = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: note_index_2);
    let create_note_2_actions = user_1.create_note(note: note_2);
    let expected_enc_note_1 = user_1
        .compute_enc_note(
            recipient: user_2, :token, index: note_index_1, :amount, random: note_1.random,
        );
    let expected_enc_note_2 = user_1
        .compute_enc_note(
            recipient: user_2, :token, index: note_index_2, :amount, random: note_2.random,
        );
    assert_ne!(expected_enc_note_1.id, expected_enc_note_2.id);
    assert_ne!(expected_enc_note_1.enc_amount, expected_enc_note_2.enc_amount);
    assert_eq!(create_note_1_actions, expected_enc_note_1.to_server_actions());
    assert_eq!(create_note_2_actions, expected_enc_note_2.to_server_actions());
}

#[test]
#[should_panic(expected: 'ZERO_RECIPIENT_ADDR')]
fn test_create_note_zero_recipient_addr() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.mock_new_token();
    user_2.address = Zero::zero();
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'ZERO_TOKEN')]
fn test_create_note_zero_token() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_2, token: Zero::zero(), amount: 1, index: 0,
        );
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'ZERO_AMOUNT')]
fn test_create_note_zero_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.mock_new_token();
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: 0, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'ZERO_RANDOM')]
fn test_create_note_zero_random() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.mock_new_token();
    let note = user_1
        .new_note(recipient: user_2, :token, amount: 1, index: 0, random: Zero::zero());
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'ZERO_OWNER_PRIVATE_KEY')]
fn test_create_note_zero_owner_private_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    user_1.private_key = Zero::zero();
    let user_2 = test.new_user();
    let token = test.mock_new_token();
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'PRIVATE_KEY_NOT_CANONICAL')]
fn test_create_note_private_key_not_canonical() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    user_1.private_key = Neg::neg(user_1.private_key);
    let user_2 = test.new_user();
    let token = test.mock_new_token();
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'RANDOM_EXCEEDS_120_BITS')]
fn test_create_note_random_exceeds_120_bits() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.mock_new_token();
    let note = user_1
        .new_note(
            recipient: user_2, :token, amount: 1, index: 0, random: TWO_POW_120.try_into().unwrap(),
        );
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'ZERO_RECIPIENT_PUBLIC_KEY')]
fn test_create_note_zero_recipient_public_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.mock_new_token();
    let mut note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: 1, index: 0);
    note.recipient_public_key = Zero::zero();
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'INVALID_SUBCHANNEL')]
fn test_create_note_invalid_subchannel_channel_doesnt_exist() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'INVALID_SUBCHANNEL')]
fn test_create_note_invalid_subchannel_subchannel_doesnt_exist() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2);
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'INVALID_SUBCHANNEL')]
fn test_create_note_invalid_subchannel_wrong_addr() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: 1, index: 0);
    user_1.address = user_2.address;
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'INVALID_SUBCHANNEL')]
fn test_create_note_invalid_subchannel_wrong_private_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: 1, index: 0);
    user_1.private_key = user_1.public_key;
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'INVALID_SUBCHANNEL')]
fn test_create_note_invalid_subchannel_wrong_public_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    user_2.public_key = user_1.public_key;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'INVALID_SUBCHANNEL')]
fn test_create_note_invalid_subchannel_wrong_token() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let mut note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: 1, index: 0);
    note.token = test.mock_new_token();
    user_1.create_note(:note);
}

#[should_panic(expected: 'INDEX_NOT_SEQUENTIAL')]
fn test_create_note_index_not_sequential() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let amount = 1;
    let note = user_1.new_note_with_generated_random(recipient: user_2, :token, :amount, index: 1);
    user_1.create_note(:note);
}

#[test]
fn test_create_note_decrypt_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: note_index);
    let create_note_actions = user_1.create_note(:note);
    user_1.privacy.execute_actions(actions: create_note_actions);

    // User 2 should be able to decrypt the amount.
    // Decrypt channel key.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (channel_key, _) = decrypt_channel_info(:enc_channel_info, private_key: user_2.private_key);
    let note_id = compute_note_id(:channel_key, :token, index: note_index);
    let enc_amount = user_2.privacy.get_note(:note_id);
    let decrypted_amount = decrypt_note_amount(enc_note_value: enc_amount, :channel_key);
    assert_eq!(decrypted_amount, amount);
}

#[test]
#[feature("safe_dispatcher")]
fn test_deposit_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.mock_new_token();
    let amount = 100;

    // Catch ZERO_TOKEN.
    let result = user.safe_deposit(token: Zero::zero(), :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT.
    let result = user.safe_deposit(:token, amount: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);
}

#[test]
fn test_use_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let note_path = NotePath { channel_key, token, note_index };
    let actions = user_2.use_note(note: note_path);
    let nullifier = user_2.compute_nullifier(sender: user_1, :token, :note_index);
    let nullifier_storage_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let expected_actions = [ServerAction::WriteIfZero((nullifier_storage_path, true.into()))]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_use_note_self_note() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.register_e2e();
    let token = test.mock_new_token();
    user.open_channel_with_token_e2e(recipient: user, :token, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user
        .new_note_with_generated_random(recipient: user, :token, :amount, index: note_index);
    user.cheat_create_note_e2e(:note);
    let channel_key = user.compute_channel_key(recipient: user);
    let note_path = NotePath { channel_key, token, note_index };
    let actions = user.use_note(note: note_path);
    let nullifier = user.compute_nullifier(sender: user, :token, :note_index);
    let nullifier_storage_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let expected_actions = [ServerAction::WriteIfZero((nullifier_storage_path, true.into()))]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_use_note_multiple_notes() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_2.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let amount_1 = 1;
    let amount_2 = 2;
    let note_1 = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: amount_1, index: 0);
    let note_2 = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: amount_2, index: 1);
    let note_3 = user_2
        .new_note_with_generated_random(recipient: user_2, :token, amount: amount_1, index: 0);
    user_1.cheat_create_note_e2e(note: note_1);
    user_1.cheat_create_note_e2e(note: note_2);
    user_2.cheat_create_note_e2e(note: note_3);
    let channel_key_1 = user_1.compute_channel_key(recipient: user_2);
    let channel_key_2 = user_2.compute_channel_key(recipient: user_2);
    let note_1_path = NotePath { channel_key: channel_key_1, token, note_index: 0 };
    let note_2_path = NotePath { channel_key: channel_key_1, token, note_index: 1 };
    let note_3_path = NotePath { channel_key: channel_key_2, token, note_index: 0 };
    let actions_1 = user_2.use_note(note: note_1_path);
    let actions_2 = user_2.use_note(note: note_2_path);
    let actions_3 = user_2.use_note(note: note_3_path);
    let expected_nullifier_1 = user_2.compute_nullifier(sender: user_1, :token, note_index: 0);
    let expected_nullifier_2 = user_2.compute_nullifier(sender: user_1, :token, note_index: 1);
    let expected_nullifier_3 = user_2.compute_nullifier(sender: user_2, :token, note_index: 0);
    let nullifier_storage_path_1 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_1].span(),
    );
    let nullifier_storage_path_2 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_2].span(),
    );
    let nullifier_storage_path_3 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_3].span(),
    );
    let expected_actions_1 = [ServerAction::WriteIfZero((nullifier_storage_path_1, true.into()))]
        .span();
    let expected_actions_2 = [ServerAction::WriteIfZero((nullifier_storage_path_2, true.into()))]
        .span();
    let expected_actions_3 = [ServerAction::WriteIfZero((nullifier_storage_path_3, true.into()))]
        .span();
    assert_eq!(actions_1, expected_actions_1);
    assert_eq!(actions_2, expected_actions_2);
    assert_eq!(actions_3, expected_actions_3);
}

#[test]
fn test_use_note_same_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let amount = 1;
    let note_1 = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: 0);
    let note_2 = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: 1);
    user_1.cheat_create_note_e2e(note: note_1);
    user_1.cheat_create_note_e2e(note: note_2);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let note_path_1 = NotePath { channel_key, token, note_index: 0 };
    let note_path_2 = NotePath { channel_key, token, note_index: 1 };
    let actions_1 = user_2.use_note(note: note_path_1);
    let actions_2 = user_2.use_note(note: note_path_2);
    let expected_nullifier_1 = user_2.compute_nullifier(sender: user_1, :token, note_index: 0);
    let expected_nullifier_2 = user_2.compute_nullifier(sender: user_1, :token, note_index: 1);
    let nullifier_storage_path_1 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_1].span(),
    );
    let nullifier_storage_path_2 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_2].span(),
    );
    let expected_actions_1 = [ServerAction::WriteIfZero((nullifier_storage_path_1, true.into()))]
        .span();
    let expected_actions_2 = [ServerAction::WriteIfZero((nullifier_storage_path_2, true.into()))]
        .span();
    assert_eq!(actions_1, expected_actions_1);
    assert_eq!(actions_2, expected_actions_2);
}

#[test]
#[should_panic(expected: 'ZERO_TOKEN')]
fn test_use_note_zero_token() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let channel_key = user_1.compute_channel_key(recipient: user_1);
    let note_path = NotePath { channel_key, token: Zero::zero(), note_index: 0 };
    user_1.use_note(note: note_path);
}

#[test]
#[should_panic(expected: 'ZERO_CHANNEL_KEY')]
fn test_use_note_zero_channel_key() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let token = test.mock_new_token();
    let note_path = NotePath { channel_key: Zero::zero(), token, note_index: 0 };
    user_1.use_note(note: note_path);
}

#[test]
#[should_panic(expected: 'ZERO_OWNER_PRIVATE_KEY')]
fn test_use_note_zero_owner_private_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    user_1.private_key = Zero::zero();
    let token = test.mock_new_token();
    let channel_key = user_1.compute_channel_key(recipient: user_1);
    let note_path = NotePath { channel_key, token, note_index: 0 };
    user_1.use_note(note: note_path);
}

#[test]
#[should_panic(expected: 'PRIVATE_KEY_NOT_CANONICAL')]
fn test_use_note_private_key_not_canonical() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    user_1.private_key = Neg::neg(user_1.private_key);
    let token = test.mock_new_token();
    let channel_key = user_1.compute_channel_key(recipient: user_1);
    let note_path = NotePath { channel_key, token, note_index: 0 };
    user_1.use_note(note: note_path);
}

#[test]
#[should_panic(expected: 'INVALID_SUBCHANNEL')]
fn test_use_note_wrong_owner_addr() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    user_2.open_channel_e2e(recipient: user_1);
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, amount: 1, index: 0);
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let note_path = NotePath { channel_key, token, note_index: 0 };
    user_2.address = user_1.address;
    user_2.use_note(note: note_path);
}

#[test]
#[should_panic(expected: 'INVALID_SUBCHANNEL')]
fn test_use_note_wrong_owner_private_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let note_path = NotePath { channel_key, token, note_index };
    user_2.replace_private_key(private_key: test.new_private_key());
    user_2.replace_key_e2e();
    user_1.open_channel_e2e(recipient: user_2);
    user_2.use_note(note: note_path);
}

#[test]
#[should_panic(expected: 'NOTE_NOT_FOUND')]
fn test_use_note_wrong_note_index() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let note_path = NotePath { channel_key, token, note_index: note_index + 1 };
    user_2.use_note(note: note_path);
}

#[test]
#[should_panic(expected: 'INVALID_SUBCHANNEL')]
fn test_use_note_wrong_channel_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2);
    user_2.open_channel_e2e(recipient: user_2);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let wrong_channel_key = user_1.compute_channel_key(recipient: user_1);
    let note_path = NotePath { channel_key: wrong_channel_key, token, note_index };
    user_2.use_note(note: note_path);
}

#[test]
#[should_panic(expected: 'INVALID_SUBCHANNEL')]
fn test_use_note_wrong_token() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let wrong_token = test.mock_new_token();
    let note_path = NotePath { channel_key, token: wrong_token, note_index };
    user_2.use_note(note: note_path);
}

#[test]
fn test_use_note_find_nullifier() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.register_e2e();
    user_2.register_e2e();
    let token = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: note_index);
    user_1.cheat_create_note_e2e(:note);

    // User 2 should be able to find the nullifier.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (channel_key, _) = decrypt_channel_info(:enc_channel_info, private_key: user_2.private_key);
    let expected_nullifier = compute_nullifier(
        :channel_key, :token, index: note_index, owner_private_key: user_2.private_key,
    );
    assert!(!user_2.privacy.nullifier_exists(nullifier: expected_nullifier));

    // User 2 uses the note.
    let note_path = NotePath { channel_key, token, note_index };
    let actions = user_2.use_note(note: note_path);
    let nullifier_storage_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let expected_actions = [ServerAction::WriteIfZero((nullifier_storage_path, true.into()))]
        .span();
    assert_eq!(actions, expected_actions);
    user_2.privacy.cheat_use_note(nullifier: expected_nullifier);

    assert!(user_2.privacy.nullifier_exists(nullifier: expected_nullifier));
}
// TODO: Test use note with all fields of note same but one field different, for each field - test
// nullifier are different.
// TODO: Test create note with all fields of note same but one field different, for each field -
// test note_ids (and maybe enc_amount) are different.
// TODO: Same for subchannels, channels, etc.

#[test]
fn test_withdraw_different_targets() {
    let mut test = Default::default();
    let token = test.mock_new_token();
    let amount = 100;

    // Setup users.
    let mut user_1 = test.new_user(); // Owner.
    let mut user_2 = test.new_user(); // Registered user.
    let user_3 = test.new_user(); // Not registered.
    user_1.register_e2e();
    user_2.register_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_1, :token, subchannel_index: 0);

    // Withdraw note to self.
    let actions = user_1.withdraw(withdrawal_target: user_1.address, :token, :amount);
    let expected_actions = [ServerAction::TransferTo((user_1.address, token, amount)),].span();
    assert_eq!(actions, expected_actions);

    // Withdraw note to other registered user.
    let actions = user_1.withdraw(withdrawal_target: user_2.address, :token, :amount);
    let expected_actions = [ServerAction::TransferTo((user_2.address, token, amount)),].span();
    assert_eq!(actions, expected_actions);

    // Withdraw note to not registered user.
    let actions = user_1.withdraw(withdrawal_target: user_3.address, :token, :amount);
    let expected_actions = [ServerAction::TransferTo((user_3.address, token, amount)),].span();
    assert_eq!(actions, expected_actions);
}

#[test]
#[feature("safe_dispatcher")]
fn test_withdraw_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.mock_new_token();
    let amount = 100;

    // Catch ZERO_WITHDRAWAL_TARGET.
    let result = user_1.safe_withdraw(withdrawal_target: Zero::zero(), :token, :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_WITHDRAWAL_TARGET);

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_withdraw(withdrawal_target: user_2.address, token: Zero::zero(), :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT.
    let result = user_1
        .safe_withdraw(withdrawal_target: user_2.address, :token, amount: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);
}

#[test]
fn test_replace_key() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let original_public_key = user.public_key;

    // Register the user first.
    user.register_e2e();
    assert_eq!(user.get_public_key(), original_public_key);

    // Replace the public key.
    user.new_key();
    let (random, actions) = user.replace_key_with_generated_random();
    let public_key_storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let enc_private_key_storage_path_felt = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [user.address.into()].span(),
    );
    let expected_enc_private_key = user.compute_enc_private_key(:random);
    let expected_actions = [
        ServerAction::WriteIfNonZero((public_key_storage_path_felt, user.public_key)),
        ServerAction::WriteIfNonZeroPrivateKey(
            (enc_private_key_storage_path_felt, expected_enc_private_key),
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_replace_key_sanity() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let original_private_key = user.private_key;
    let original_public_key = user.public_key;

    // Register the user first.
    let random = user.register_e2e();
    assert_eq!(user.get_public_key(), original_public_key);
    let enc_private_key_1 = user.compute_enc_private_key(:random);
    assert_eq!(user.get_enc_private_key(), enc_private_key_1);

    // Replace the public key first time.
    user.new_key();
    let random = user.replace_key_e2e();
    let enc_private_key_2 = user.compute_enc_private_key(:random);
    assert_eq!(user.get_public_key(), user.public_key);
    assert_eq!(user.get_enc_private_key(), enc_private_key_2);

    // Replace the public key second time.
    user.new_key();
    let random = user.replace_key_e2e();
    let enc_private_key_3 = user.compute_enc_private_key(:random);
    assert_eq!(user.get_public_key(), user.public_key);
    assert_eq!(user.get_enc_private_key(), enc_private_key_3);

    // Replace back to original public key.
    user.private_key = original_private_key;
    let random = user.replace_key_e2e();
    let enc_private_key_4 = user.compute_enc_private_key(:random);
    assert_eq!(user.get_public_key(), original_public_key);
    assert_eq!(user.get_enc_private_key(), enc_private_key_4);
}

#[test]
fn test_replace_key_same_key() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let original_public_key = user.public_key;

    // Register the user first.
    let register_random = user.register_e2e();
    assert_eq!(user.get_public_key(), original_public_key);
    let enc_private_key_1 = user.compute_enc_private_key(random: register_random);
    assert_eq!(user.get_enc_private_key(), enc_private_key_1);

    // Replace with the same key.
    let random = user.replace_key_e2e();
    let enc_private_key_2 = user.compute_enc_private_key(:random);
    assert_eq!(user.get_public_key(), original_public_key);
    assert_eq!(user.get_enc_private_key(), enc_private_key_2);

    // Replace with the same key and same random.
    let actions = user.replace_key(:random);
    user.privacy.execute_actions(:actions);
    assert_eq!(user.get_public_key(), original_public_key);
    assert_eq!(user.get_enc_private_key(), enc_private_key_2);

    // Replace with the same key and same random from registeration.
    let actions = user.replace_key(random: register_random);
    user.privacy.execute_actions(:actions);
    assert_eq!(user.get_public_key(), original_public_key);
    assert_eq!(user.get_enc_private_key(), enc_private_key_1);
}

#[test]
fn test_replace_key_to_other_user_key() {
    let mut test: Test = Default::default();
    let mut user1 = test.new_user();
    let mut user2 = test.new_user();
    let user1_original_key = user1.public_key;
    let user2_public_key = user2.public_key;

    // Register both users.
    user1.register_e2e();
    user2.register_e2e();

    // Verify initial keys.
    assert_eq!(user1.get_public_key(), user1_original_key);
    assert_eq!(user2.get_public_key(), user2_public_key);

    // User1 replaces their public key to user2's public key.
    user1.private_key = user2.private_key;
    user1.replace_key_e2e();

    // Verify user1 now has user2's public key.
    assert_eq!(user1.get_public_key(), user2_public_key);
    // Verify user2's key is unchanged.
    assert_eq!(user2.get_public_key(), user2_public_key);
}

#[test]
#[feature("safe_dispatcher")]
fn test_replace_key_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let random = user.get_random().into();

    // Catch ZERO_PRIVATE_KEY.
    let mut user_zero_private_key = user;
    user_zero_private_key.private_key = Zero::zero();
    let result = user_zero_private_key.safe_replace_key(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

    // Catch ZERO_RANDOM.
    let result = user.safe_replace_key(random: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_key_not_canonical = user;
    user_key_not_canonical.private_key = Neg::neg(user.private_key);
    let result = user_key_not_canonical.safe_replace_key(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_replace_key(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
}

#[test]
fn test_replace_key_decrypt_private_key() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.register_e2e();
    user.new_key();
    user.replace_key_e2e();

    // Compliance should be able to decrypt the private key.
    let enc_private_key = user.get_enc_private_key();
    let decrypted_private_key = decrypt_private_key(
        :enc_private_key, compliance_private_key: test.compliance_private_key,
    );
    assert_eq!(decrypted_private_key, user.private_key);
}

// TODO: Consider splitting to test per action.
#[test]
fn test_compile_client_actions() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.mock_new_token();

    // Empty actions.
    let actions = user_1.compile_client_actions(client_actions: [].span());
    assert_eq!(actions, [].span());

    // Register action.
    let random = user_1.get_random().into();
    let actions = user_1
        .compile_client_actions(
            client_actions: [ClientAction::Register((user_1.private_key, random))].span(),
        );
    let enc_private_key = user_1.compute_enc_private_key(:random);
    let public_key_storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user_1.address.into()].span(),
    );
    let enc_private_key_storage_path_felt = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [user_1.address.into()].span(),
    );
    let expected_actions = [
        ServerAction::WriteIfZero((public_key_storage_path_felt, user_1.public_key)),
        ServerAction::WriteIfZeroPrivateKey((enc_private_key_storage_path_felt, enc_private_key)),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Replace key action.
    let actions = user_1
        .compile_client_actions(
            client_actions: [ClientAction::ReplaceKey((user_1.private_key, random))].span(),
        );
    let expected_actions = [
        ServerAction::WriteIfNonZero((public_key_storage_path_felt, user_1.public_key)),
        ServerAction::WriteIfNonZeroPrivateKey(
            (enc_private_key_storage_path_felt, enc_private_key),
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Open channel action.
    user_1.register_e2e();
    user_2.register_e2e();
    let random = user_1.get_random().into();
    let actions = user_1
        .compile_client_actions(
            client_actions: [
                ClientAction::OpenChannel(
                    (user_1.private_key, user_2.address, user_2.public_key, random),
                )
            ]
                .span(),
        );
    let expected_channel_id = user_1.compute_channel_id(recipient: user_2);
    let expected_channel_key = user_1.compute_channel_key(recipient: user_2);
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random,
        recipient_public_key: user_2.public_key,
        channel_key: expected_channel_key,
        sender_addr: user_1.address,
    );
    let recipient_public_key_storage_path = map_entry_address(
        map_selector: selector!("public_key"), keys: [user_2.address.into()].span(),
    );
    let channel_exists_storage_path = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_id].span(),
    );
    let expected_actions = array![
        ServerAction::VerifyValue((recipient_public_key_storage_path, user_2.public_key)),
        ServerAction::WriteIfZero((channel_exists_storage_path, true.into())),
        ServerAction::AppendToVec((user_2.address, user_2.public_key, expected_enc_channel_info)),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Open subchannel action.
    let random = user_1.open_channel_e2e(recipient: user_2);
    let actions = user_1
        .compile_client_actions(
            client_actions: [
                ClientAction::OpenSubchannel(
                    (user_2.address, user_2.public_key, expected_channel_key, 0, token, random),
                ),
            ]
                .span(),
        );
    let expected_subchannel_id = user_1.compute_subchannel_id(recipient: user_2, :token);
    let expected_subchannel_key = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_enc_subchannel_info = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token, :random);
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
    assert_eq!(actions, expected_actions);

    // Create note action.
    let amount = 1;
    let note_index = 0;
    let subchannel_index = 0;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token, :amount, index: note_index);
    user_1.open_subchannel_e2e(recipient: user_2, :token, index: subchannel_index);
    let actions = user_1.create_note(:note);
    let expected_enc_note = user_1
        .compute_enc_note(
            recipient: user_2, :token, index: note_index, :amount, random: note.random,
        );
    assert_eq!(actions, expected_enc_note.to_server_actions());

    // Deposit action.
    let actions = user_1.deposit(:token, :amount);
    let expected_actions = [ServerAction::TransferFrom((user_1.address, token, amount))].span();
    assert_eq!(actions, expected_actions);

    // Use note action.
    user_1.cheat_create_note_e2e(:note);
    let nullifier = user_2.compute_nullifier(sender: user_1, :token, :note_index);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let note_path = NotePath { channel_key, token, note_index };
    let actions = user_2.use_note(note: note_path);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let expected_actions = [ServerAction::WriteIfZero((storage_path_felt_nullifier, true.into()))]
        .span();
    assert_eq!(actions, expected_actions);

    // Withdraw action.
    let actions = user_2.withdraw(withdrawal_target: user_1.address, :token, :amount);
    let expected_actions = [ServerAction::TransferTo((user_1.address, token, amount))].span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_compile_client_actions_assertions() {
    let mut test: Test = Default::default();
    let user = test.new_user();

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_compile_client_actions(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
}
// TODO: Test with the negative private key (not canonical but the right public key) for each action
// that gets a private key as an input.


