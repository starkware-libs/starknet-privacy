use core::num::traits::Zero;
use privacy::actions::{
    AppendToVecInput, ClientAction, CreateNoteInput, DepositInput, OpenChannelInput,
    OpenSubchannelInput, ServerAction, SetViewingKeyInput, TransferFromInput, TransferToInput,
    UseNoteInput, VerifyValueInput, WithdrawInput, WriteIfZeroInput, WriteIfZeroPrivateKeyInput,
    WriteIfZeroSubchannelInput,
};
use privacy::errors;
use privacy::hashes::{compute_note_id, compute_nullifier, compute_subchannel_key};
use privacy::tests::utils_for_tests::{
    EncNoteTrait, PrivacyCfgTrait, Test, TestTrait, UserTrait, decrypt_channel_info,
    decrypt_private_key, decrypt_subchannel_token, spy_messages_to_server_actions,
};
use privacy::utils::constants::TWO_POW_120;
use privacy::utils::{decrypt_note_amount, encrypt_channel_info, is_canonical_key};
use snforge_std::{TokenTrait, map_entry_address, spy_messages_to_l1};
use starknet::VALIDATED;
use starkware_utils_testing::test_utils::assert_panic_with_felt_error;

// TODO: Catch server errors in the client side.

#[test]
fn test_validate() {
    let mut test: Test = Default::default();
    let validated = test.privacy.validate(user_addr: Zero::zero(), client_actions: [].span());
    assert_eq!(validated, VALIDATED);
    let mut user = test.new_user();
    let client_actions = [
        ClientAction::SetViewingKey(
            SetViewingKeyInput { private_key: user.private_key, random: user.get_random().into() },
        )
    ]
        .span();
    let validated = test.privacy.validate(user_addr: user.address, :client_actions);
    assert_eq!(validated, VALIDATED);
}

#[test]
fn test_set_viewing_key() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let public_key = user.public_key;
    let (random, actions) = user.internal_set_viewing_key_with_generated_random();
    let enc_private_key = user.compute_enc_private_key(:random);

    let public_key_storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let enc_private_key_storage_path_felt = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [user.address.into()].span(),
    );
    let expected_actions = [
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: public_key_storage_path_felt, value: public_key },
        ),
        ServerAction::WriteIfZeroPrivateKey(
            WriteIfZeroPrivateKeyInput {
                storage_address: enc_private_key_storage_path_felt, value: enc_private_key,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
#[feature("safe_dispatcher")]
fn test_set_viewing_key_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let random = user.get_random().into();

    // Catch ZERO_PRIVATE_KEY.
    let mut user_zero_public_key = user;
    user_zero_public_key.private_key = Zero::zero();
    let result = user_zero_public_key.safe_set_viewing_key(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

    // Catch ZERO_RANDOM.
    let result = user.safe_set_viewing_key(random: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_key_not_canonical = user;
    user_key_not_canonical.private_key = Neg::neg(user.private_key);
    let result = user_key_not_canonical.safe_set_viewing_key(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_set_viewing_key(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
}

#[test]
fn test_set_viewing_key_decrypt_private_key() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();

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
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    user_1.open_channel_with_token_e2e(recipient: user_1, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_1, :token_address, :amount, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_1);

    let use_note_input = UseNoteInput {
        owner_private_key: user_1.private_key, channel_key, token: token_address, note_index,
    };
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    let actions = user_1
        .transfer(notes_to_use: [use_note_input].span(), notes_to_create: [note].span());

    let expected_nullifier = user_1.compute_nullifier(sender: user_1, :token_address, :note_index);
    let enc_note = user_1
        .compute_enc_note(
            recipient: user_2, :token_address, index: note_index, :amount, random: note.random,
        );
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let storage_path_felt_note = map_entry_address(
        map_selector: selector!("notes"), keys: [enc_note.id].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt_nullifier, value: true.into() },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: storage_path_felt_note, value: enc_note.enc_amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(note_id: enc_note.id), enc_note.enc_amount);
}

#[test]
fn test_transfer_to_self() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_1, :token_address, subchannel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_1, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_2
        .new_note_with_generated_random(
            recipient: user_1, :token_address, :amount, index: note_index,
        );
    user_2.cheat_create_note_e2e(:note);
    let channel_key = user_2.compute_channel_key(recipient: user_1);

    let use_note_input = UseNoteInput {
        owner_private_key: user_1.private_key, channel_key, token: token_address, note_index,
    };
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_1, :token_address, :amount, index: note_index,
        );

    let actions = user_1
        .transfer(notes_to_use: [use_note_input].span(), notes_to_create: [note].span());
    let expected_nullifier = user_1.compute_nullifier(sender: user_2, :token_address, :note_index);
    let enc_note = user_1
        .compute_enc_note(
            recipient: user_1, :token_address, index: note_index, :amount, random: note.random,
        );
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let storage_path_felt_note = map_entry_address(
        map_selector: selector!("notes"), keys: [enc_note.id].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt_nullifier, value: true.into() },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: storage_path_felt_note, value: enc_note.enc_amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(note_id: enc_note.id), enc_note.enc_amount);
}

#[test]
fn test_transfer_one_to_many() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_3.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    user_1.open_channel_with_token_e2e(recipient: user_3, :token_address, subchannel_index: 0);
    user_1.open_channel_with_token_e2e(recipient: user_1, :token_address, subchannel_index: 0);
    let note_index = 0;
    let amount_1 = 1;
    let amount_2 = 8;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_1, :token_address, amount: amount_1 + amount_2, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_1);

    let use_note_input = UseNoteInput {
        owner_private_key: user_1.private_key, channel_key, token: token_address, note_index,
    };
    let note_1 = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, amount: amount_1, index: note_index,
        );
    let note_2 = user_1
        .new_note_with_generated_random(
            recipient: user_3, :token_address, amount: amount_2, index: note_index,
        );

    let actions = user_1
        .transfer(notes_to_use: [use_note_input].span(), notes_to_create: [note_1, note_2].span());
    let expected_nullifier = user_1.compute_nullifier(sender: user_1, :token_address, :note_index);
    let enc_note_1 = user_1
        .compute_enc_note(
            recipient: user_2,
            :token_address,
            index: note_index,
            amount: amount_1,
            random: note_1.random,
        );
    let enc_note_2 = user_1
        .compute_enc_note(
            recipient: user_3,
            :token_address,
            index: note_index,
            amount: amount_2,
            random: note_2.random,
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt_nullifier, value: true.into() },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: storage_path_felt_note_1, value: enc_note_1.enc_amount,
            },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: storage_path_felt_note_2, value: enc_note_2.enc_amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(note_id: enc_note_1.id), enc_note_1.enc_amount);
    assert_eq!(test.privacy.get_note(note_id: enc_note_2.id), enc_note_2.enc_amount);
}

#[test]
fn test_transfer_many_to_one() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let token_address = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_3.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_1, :token_address, subchannel_index: 0);
    user_3.open_channel_with_token_e2e(recipient: user_1, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_2
        .new_note_with_generated_random(
            recipient: user_1, :token_address, :amount, index: note_index,
        );
    user_2.cheat_create_note_e2e(:note);
    let channel_key_1 = user_2.compute_channel_key(recipient: user_1);
    let note = user_3
        .new_note_with_generated_random(
            recipient: user_1, :token_address, :amount, index: note_index,
        );
    user_3.cheat_create_note_e2e(:note);
    let channel_key_2 = user_3.compute_channel_key(recipient: user_1);

    let use_note_input_1 = UseNoteInput {
        owner_private_key: user_1.private_key,
        channel_key: channel_key_1,
        token: token_address,
        note_index: 0,
    };
    let use_note_input_2 = UseNoteInput {
        owner_private_key: user_1.private_key,
        channel_key: channel_key_2,
        token: token_address,
        note_index: 0,
    };
    let amount = 2 * amount;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index,
        );

    let actions = user_1
        .transfer(
            notes_to_use: [use_note_input_1, use_note_input_2].span(),
            notes_to_create: [note].span(),
        );

    // Test use_note output.
    let expected_nullifier_1 = user_1
        .compute_nullifier(sender: user_2, :token_address, :note_index);
    let expected_nullifier_2 = user_1
        .compute_nullifier(sender: user_3, :token_address, :note_index);
    assert_ne!(expected_nullifier_1, expected_nullifier_2);
    let enc_note = user_1
        .compute_enc_note(
            recipient: user_2, :token_address, index: note_index, :amount, random: note.random,
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt_nullifier_1, value: true.into() },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt_nullifier_2, value: true.into() },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: storage_path_felt_note, value: enc_note.enc_amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier_1));
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier_2));
    assert_eq!(test.privacy.get_note(note_id: enc_note.id), enc_note.enc_amount);
}

#[test]
fn test_transfer_many_to_many() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let token_address = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_3.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_3, :token_address, subchannel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_3, :token_address, subchannel_index: 0);
    user_3.open_channel_with_token_e2e(recipient: user_1, :token_address, subchannel_index: 0);
    user_3.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_3, :token_address, :amount, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);
    let channel_key_1 = user_1.compute_channel_key(recipient: user_3);
    let note = user_2
        .new_note_with_generated_random(
            recipient: user_3, :token_address, :amount, index: note_index,
        );
    user_2.cheat_create_note_e2e(:note);
    let channel_key_2 = user_2.compute_channel_key(recipient: user_3);

    let use_note_input_1 = UseNoteInput {
        owner_private_key: user_3.private_key,
        channel_key: channel_key_1,
        token: token_address,
        note_index: 0,
    };
    let use_note_input_2 = UseNoteInput {
        owner_private_key: user_3.private_key,
        channel_key: channel_key_2,
        token: token_address,
        note_index: 0,
    };
    let note_1 = user_3
        .new_note_with_generated_random(
            recipient: user_1, :token_address, :amount, index: note_index,
        );
    let note_2 = user_3
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index,
        );

    let actions = user_3
        .transfer(
            notes_to_use: [use_note_input_1, use_note_input_2].span(),
            notes_to_create: [note_1, note_2].span(),
        );

    let expected_nullifier_1 = user_3
        .compute_nullifier(sender: user_1, :token_address, :note_index);
    let expected_nullifier_2 = user_3
        .compute_nullifier(sender: user_2, :token_address, :note_index);
    assert_ne!(expected_nullifier_1, expected_nullifier_2);
    let enc_note_1 = user_3
        .compute_enc_note(
            recipient: user_1, :token_address, index: note_index, :amount, random: note_1.random,
        );
    let enc_note_2 = user_3
        .compute_enc_note(
            recipient: user_2, :token_address, index: note_index, :amount, random: note_2.random,
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt_nullifier_1, value: true.into() },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt_nullifier_2, value: true.into() },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: storage_path_felt_note_1, value: enc_note_1.enc_amount,
            },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: storage_path_felt_note_2, value: enc_note_2.enc_amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier_1));
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier_2));
    assert_eq!(test.privacy.get_note(note_id: enc_note_1.id), enc_note_1.enc_amount);
    assert_eq!(test.privacy.get_note(note_id: enc_note_2.id), enc_note_2.enc_amount);
}

// TODO: Fix this test. Now failing because storage writings are not reverted when panicking.
#[test]
#[feature("safe_dispatcher")]
#[ignore]
fn test_transfer_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let token_address = test.mock_new_token();
    let channel_key = user_1.compute_channel_key(recipient: user_1);

    let use_note_input = UseNoteInput {
        owner_private_key: user_1.private_key, channel_key, token: token_address, note_index: 0,
    };
    let create_note_input = CreateNoteInput {
        sender_private_key: user_1.private_key,
        recipient_addr: user_3.address,
        recipient_public_key: user_3.public_key,
        token: token_address,
        amount: 1,
        index: 0,
        random: user_1.get_random(),
    };

    // Catch ZERO_USER_ADDR.
    let mut user_1_zero = user_1;
    user_1_zero.address = Zero::zero();
    let result = user_1_zero
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Use note errors.

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_transfer(
            notes_to_use: [UseNoteInput { token: Zero::zero(), ..use_note_input }].span(),
            notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_CHANNEL_KEY.
    let result = user_1
        .safe_transfer(
            notes_to_use: [UseNoteInput { channel_key: Zero::zero(), ..use_note_input }].span(),
            notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_CHANNEL_KEY);

    // Catch ZERO_PRIVATE_KEY.
    let result = user_1
        .safe_transfer(
            notes_to_use: [UseNoteInput { owner_private_key: Zero::zero(), ..use_note_input }]
                .span(),
            notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let result = user_1
        .safe_transfer(
            notes_to_use: [
                UseNoteInput {
                    owner_private_key: Neg::neg(use_note_input.owner_private_key), ..use_note_input,
                }
            ]
                .span(),
            notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch SUBCHANNEL_NOT_FOUND - channel doesnt exist.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    user_1.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_1);

    // Catch SUBCHANNEL_NOT_FOUND - subchannel doesnt exist.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    user_1.open_subchannel_e2e(recipient: user_1, :token_address, index: 0);

    // Catch SUBCHANNEL_NOT_FOUND - wrong address.
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2);
    let mut user_1_wrong_addr = user_1;
    user_1_wrong_addr.address = user_2.address;
    let result = user_1_wrong_addr
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Catch SUBCHANNEL_NOT_FOUND - wrong private key.
    let result = user_1
        .safe_transfer(
            notes_to_use: [UseNoteInput { owner_private_key: user_2.private_key, ..use_note_input }]
                .span(),
            notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Catch SUBCHANNEL_NOT_FOUND - wrong token.
    let wrong_token_address = test.mock_new_token();
    let result = user_1
        .safe_transfer(
            notes_to_use: [UseNoteInput { token: wrong_token_address, ..use_note_input }].span(),
            notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Catch SUBCHANNEL_NOT_FOUND - wrong channel key.
    let wrong_channel_key = user_1.compute_channel_key(recipient: user_2);
    let result = user_1
        .safe_transfer(
            notes_to_use: [UseNoteInput { channel_key: wrong_channel_key, ..use_note_input }]
                .span(),
            notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Catch NOTE_NOT_FOUND.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    let note = user_1
        .new_note_with_generated_random(recipient: user_1, :token_address, amount: 1, index: 0);
    user_1.cheat_create_note_e2e(:note);

    // Create note errors.

    // Catch ZERO_RECIPIENT.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateNoteInput { recipient_addr: Zero::zero(), ..create_note_input }]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateNoteInput { token: Zero::zero(), ..create_note_input }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateNoteInput { amount: Zero::zero(), ..create_note_input }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);

    // Catch ZERO_RECIPIENT_PUBLIC_KEY.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [
                CreateNoteInput { recipient_public_key: Zero::zero(), ..create_note_input }
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);

    // Catch ZERO_RANDOM.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateNoteInput { random: Zero::zero(), ..create_note_input }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);

    // Catch RANDOM_EXCEEDS_120_BITS.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [
                CreateNoteInput { random: TWO_POW_120.try_into().unwrap(), ..create_note_input }
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::RANDOM_EXCEEDS_120_BITS);

    // Note: ZERO_SENDER_PRIVATE_KEY is already caught in use_note.
    // Note: PRIVATE_KEY_NOT_CANONICAL is already caught in use_note.

    user_3.set_viewing_key_e2e();

    // Catch SUBCHANNEL_NOT_FOUND - channel doesnt exist.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    user_1.open_channel_e2e(recipient: user_3);

    // Catch SUBCHANNEL_NOT_FOUND - subchannel doesnt exist.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    user_1.open_subchannel_e2e(recipient: user_3, :token_address, index: 0);

    // Catch SUBCHANNEL_NOT_FOUND - wrong public key.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [
                CreateNoteInput { recipient_public_key: user_1.public_key, ..create_note_input }
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Catch SUBCHANNEL_NOT_FOUND - wrong address.
    let mut user_1_wrong_addr = user_1;
    user_1_wrong_addr.address = user_2.address;
    let result = user_1_wrong_addr
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Catch SUBCHANNEL_NOT_FOUND - wrong private key.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [
                CreateNoteInput { sender_private_key: user_2.private_key, ..create_note_input }
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Catch SUBCHANNEL_NOT_FOUND - wrong token.
    let wrong_token_address = test.mock_new_token();
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateNoteInput { token: wrong_token_address, ..create_note_input }]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Catch INDEX_NOT_SEQUENTIAL.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateNoteInput { index: 1, ..create_note_input }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);
    // Transfer errors.

    // TODO: Catch token balances error.

    // TODO: Catch server errors.
}

#[test]
fn test_open_channel() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();

    let (random, channel_output) = user_1
        .internal_open_channel_with_generated_random(recipient: user_2);
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
        ServerAction::VerifyValue(
            VerifyValueInput { storage_address: public_key_storage_path, value: user_2.public_key },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: channel_exists_storage_path, value: true.into() },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user_2.address,
                recipient_public_key: user_2.public_key,
                enc_channel_info: expected_enc_channel_info,
            },
        ),
    ]
        .span();
    assert_eq!(channel_output, expected_actions);
}

#[test]
fn test_open_channel_self_channel() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();

    let (random, channel_output) = user
        .internal_open_channel_with_generated_random(recipient: user);
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
        ServerAction::VerifyValue(
            VerifyValueInput { storage_address: public_key_storage_path, value: user.public_key },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: channel_exists_storage_path, value: true.into() },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user.address,
                recipient_public_key: user.public_key,
                enc_channel_info: expected_enc_channel_info,
            },
        ),
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

    // Catch ZERO_PRIVATE_KEY.
    let mut user_zero_private_key = user_1;
    user_zero_private_key.private_key = Zero::zero();
    let result = user_zero_private_key.safe_open_channel(recipient: user_2, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

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
    user_1.set_viewing_key_e2e();
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
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_3.set_viewing_key_e2e();

    let (random_1, c1_output) = user_1
        .internal_open_channel_with_generated_random(recipient: user_2);
    let (random_2, c2_output) = user_1
        .internal_open_channel_with_generated_random(recipient: user_3);
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
        ServerAction::VerifyValue(
            VerifyValueInput {
                storage_address: public_key_storage_path_1, value: user_2.public_key,
            },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: channel_exists_storage_path_1, value: true.into() },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user_2.address,
                recipient_public_key: user_2.public_key,
                enc_channel_info: expected_enc_channel_info_1,
            },
        ),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::VerifyValue(
            VerifyValueInput {
                storage_address: public_key_storage_path_2, value: user_3.public_key,
            },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: channel_exists_storage_path_2, value: true.into() },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user_3.address,
                recipient_public_key: user_3.public_key,
                enc_channel_info: expected_enc_channel_info_2,
            },
        ),
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
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_3.set_viewing_key_e2e();

    let (random_1, c1_output) = user_2
        .internal_open_channel_with_generated_random(recipient: user_1);
    let (random_2, c2_output) = user_3
        .internal_open_channel_with_generated_random(recipient: user_1);
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
        ServerAction::VerifyValue(
            VerifyValueInput {
                storage_address: public_key_storage_path_1, value: user_1.public_key,
            },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: channel_exists_storage_path_1, value: true.into() },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user_1.address,
                recipient_public_key: user_1.public_key,
                enc_channel_info: expected_enc_channel_info_1,
            },
        ),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::VerifyValue(
            VerifyValueInput {
                storage_address: public_key_storage_path_2, value: user_1.public_key,
            },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: channel_exists_storage_path_2, value: true.into() },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user_1.address,
                recipient_public_key: user_1.public_key,
                enc_channel_info: expected_enc_channel_info_2,
            },
        ),
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
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
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
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2);

    let (random, channel_output) = user_1
        .internal_open_subchannel_with_generated_random(
            recipient: user_2, :token_address, index: 0,
        );
    let expected_subchannel_key = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_enc_subchannel_info = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_address, :random);
    let expected_subchannel_id = user_1.compute_subchannel_id(recipient: user_2, :token_address);

    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: subchannel_exists_storage_path_felt, value: true.into(),
            },
        ),
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroSubchannelInput {
                storage_address: subchannel_tokens_storage_path_felt,
                value: expected_enc_subchannel_info,
            },
        ),
    ]
        .span();
    assert_eq!(channel_output, expected_actions);
}

#[test]
fn test_open_subchannel_self_channel() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user.open_channel_e2e(recipient: user);

    let (random, channel_output) = user
        .internal_open_subchannel_with_generated_random(recipient: user, :token_address, index: 0);
    let expected_subchannel_key = user.compute_subchannel_key(recipient: user, index: 0);
    let expected_enc_subchannel_info = user
        .compute_enc_subchannel_info(recipient: user, :token_address, :random);
    let expected_subchannel_id = user.compute_subchannel_id(recipient: user, :token_address);

    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: subchannel_exists_storage_path_felt, value: true.into(),
            },
        ),
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroSubchannelInput {
                storage_address: subchannel_tokens_storage_path_felt,
                value: expected_enc_subchannel_info,
            },
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
    let token_address = test.mock_new_token();
    let random = user_1.get_random().into();
    let index = 0;

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user_1;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr
        .safe_open_subchannel(recipient: user_2, :token_address, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch ZERO_RECIPIENT_ADDR.
    let mut user_zero_addr = user_2;
    user_zero_addr.address = Zero::zero();
    let result = user_1
        .safe_open_subchannel(recipient: user_zero_addr, :token_address, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_CHANNEL_KEY.
    let result = user_1
        .safe_open_subchannel_with_channel_key(
            recipient: user_2, :token_address, :index, :random, channel_key: Zero::zero(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_CHANNEL_KEY);

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_open_subchannel(recipient: user_2, token_address: Zero::zero(), :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_RANDOM.
    let result = user_1
        .safe_open_subchannel(recipient: user_2, :token_address, :index, random: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);

    // Catch ZERO_RECIPIENT_PUBLIC_KEY.
    let mut user_zero_public_key = user_2;
    user_zero_public_key.public_key = Zero::zero();
    let result = user_1
        .safe_open_subchannel(recipient: user_zero_public_key, :token_address, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);

    user_2.set_viewing_key_e2e();

    // Catch INVALID_CHANNEL - sender is not registered.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token_address, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    user_1.set_viewing_key_e2e();

    // Catch INVALID_CHANNEL - no channel exists for the given sender and recipient.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token_address, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    user_1.open_channel_e2e(recipient: user_2);
    let channel_key = user_1.compute_channel_key(recipient: user_2);

    // Catch INVALID_CHANNEL - wrong sender_addr.
    let mut user_1_wrong_addr = user_1;
    user_1_wrong_addr.address = user_2.address;
    let result = user_1_wrong_addr
        .safe_open_subchannel(recipient: user_2, :token_address, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INVALID_CHANNEL - wrong recipient_addr.
    let mut user_2_wrong_addr = user_2;
    user_2_wrong_addr.address = user_1.address;
    let result = user_1
        .safe_open_subchannel(recipient: user_2_wrong_addr, :token_address, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INVALID_CHANNEL - wrong recipient_public_key.
    let mut user_2_wrong_public_key = user_2;
    user_2_wrong_public_key.public_key = user_1.public_key;
    let result = user_1
        .safe_open_subchannel(recipient: user_2_wrong_public_key, :token_address, :index, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INVALID_CHANNEL - wrong channel key.
    let result = user_1
        .safe_open_subchannel_with_channel_key(
            recipient: user_2, :token_address, :index, :random, channel_key: channel_key + 1,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INDEX_NOT_SEQUENTIAL.
    let result = user_1
        .safe_open_subchannel(recipient: user_2, :token_address, index: index + 1, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);

    // Sanity check - should succeed.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token_address, :index, :random);
    assert_eq!(result.is_ok(), true);
}

#[test]
fn test_open_subchannel_multiple() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2);
    let token_address_1 = test.mock_new_token();
    let token_address_2 = test.mock_new_token();

    // Multiple subchannels with different tokens.
    let (random_1, c1_output) = user_1
        .internal_open_subchannel_with_generated_random(
            recipient: user_2, token_address: token_address_1, index: 0,
        );
    test.privacy.execute_actions(actions: c1_output);
    let (random_2, c2_output) = user_1
        .internal_open_subchannel_with_generated_random(
            recipient: user_2, token_address: token_address_2, index: 1,
        );
    let expected_subchannel_key_1 = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_subchannel_key_2 = user_1.compute_subchannel_key(recipient: user_2, index: 1);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(
            recipient: user_2, token_address: token_address_1, random: random_1,
        );
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(
            recipient: user_2, token_address: token_address_2, random: random_2,
        );
    let expected_subchannel_id_1 = user_1
        .compute_subchannel_id(recipient: user_2, token_address: token_address_1);
    let expected_subchannel_id_2 = user_1
        .compute_subchannel_id(recipient: user_2, token_address: token_address_2);
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: subchannel_exists_storage_path_felt_1, value: true.into(),
            },
        ),
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroSubchannelInput {
                storage_address: subchannel_tokens_storage_path_felt_1,
                value: expected_enc_subchannel_info_1,
            },
        ),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: subchannel_exists_storage_path_felt_2, value: true.into(),
            },
        ),
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroSubchannelInput {
                storage_address: subchannel_tokens_storage_path_felt_2,
                value: expected_enc_subchannel_info_2,
            },
        ),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);

    // Multiple subchannels with the same token (fails only on the server side).
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2);
    let token_address = test.mock_new_token();
    let (random_1, c1_output) = user_1
        .internal_open_subchannel_with_generated_random(
            recipient: user_2, :token_address, index: 0,
        );
    test.privacy.execute_actions(actions: c1_output);
    let (random_2, c2_output) = user_1
        .internal_open_subchannel_with_generated_random(
            recipient: user_2, :token_address, index: 1,
        );
    let expected_subchannel_key_1 = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_subchannel_key_2 = user_1.compute_subchannel_key(recipient: user_2, index: 1);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_address, random: random_1);
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_address, random: random_2);
    // Id will be the same since the token is the same.
    let expected_subchannel_id = user_1.compute_subchannel_id(recipient: user_2, :token_address);
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: subchannel_exists_storage_path_felt, value: true.into(),
            },
        ),
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroSubchannelInput {
                storage_address: subchannel_tokens_storage_path_felt_1,
                value: expected_enc_subchannel_info_1,
            },
        ),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: subchannel_exists_storage_path_felt, value: true.into(),
            },
        ),
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroSubchannelInput {
                storage_address: subchannel_tokens_storage_path_felt_2,
                value: expected_enc_subchannel_info_2,
            },
        ),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);

    // Multiple subchannels with the same index (fails only on the server side).
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2);
    let (random_1, c1_output) = user_1
        .internal_open_subchannel_with_generated_random(
            recipient: user_2, token_address: token_address_1, index: 0,
        );
    test.privacy.execute_actions(actions: c1_output);
    let (random_2, c2_output) = user_1
        .internal_open_subchannel_with_generated_random(
            recipient: user_2, token_address: token_address_2, index: 0,
        );
    // Key will be the same since the index is the same.
    let expected_subchannel_key = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(
            recipient: user_2, token_address: token_address_1, random: random_1,
        );
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(
            recipient: user_2, token_address: token_address_2, random: random_2,
        );
    let expected_subchannel_id_1 = user_1
        .compute_subchannel_id(recipient: user_2, token_address: token_address_1);
    let expected_subchannel_id_2 = user_1
        .compute_subchannel_id(recipient: user_2, token_address: token_address_2);
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: subchannel_exists_storage_path_felt_1, value: true.into(),
            },
        ),
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroSubchannelInput {
                storage_address: subchannel_tokens_storage_path_felt,
                value: expected_enc_subchannel_info_1,
            },
        ),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: subchannel_exists_storage_path_felt_2, value: true.into(),
            },
        ),
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroSubchannelInput {
                storage_address: subchannel_tokens_storage_path_felt,
                value: expected_enc_subchannel_info_2,
            },
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
    user.set_viewing_key_e2e();
    let token_address_1 = test.mock_new_token();
    let token_address_2 = test.mock_new_token();
    user.open_channel_e2e(recipient: user);

    // Multiple subchannels with different tokens.
    let (random_1, c1_output) = user
        .internal_open_subchannel_with_generated_random(
            recipient: user, token_address: token_address_1, index: 0,
        );
    test.privacy.execute_actions(actions: c1_output);
    let (random_2, c2_output) = user
        .internal_open_subchannel_with_generated_random(
            recipient: user, token_address: token_address_2, index: 1,
        );
    let expected_subchannel_key_1 = user.compute_subchannel_key(recipient: user, index: 0);
    let expected_subchannel_key_2 = user.compute_subchannel_key(recipient: user, index: 1);
    let expected_enc_subchannel_info_1 = user
        .compute_enc_subchannel_info(
            recipient: user, token_address: token_address_1, random: random_1,
        );
    let expected_enc_subchannel_info_2 = user
        .compute_enc_subchannel_info(
            recipient: user, token_address: token_address_2, random: random_2,
        );
    let expected_subchannel_id_1 = user
        .compute_subchannel_id(recipient: user, token_address: token_address_1);
    let expected_subchannel_id_2 = user
        .compute_subchannel_id(recipient: user, token_address: token_address_2);
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: subchannel_exists_storage_path_felt_1, value: true.into(),
            },
        ),
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroSubchannelInput {
                storage_address: subchannel_tokens_storage_path_felt_1,
                value: expected_enc_subchannel_info_1,
            },
        ),
    ]
        .span();
    let expected_actions_2 = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: subchannel_exists_storage_path_felt_2, value: true.into(),
            },
        ),
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroSubchannelInput {
                storage_address: subchannel_tokens_storage_path_felt_2,
                value: expected_enc_subchannel_info_2,
            },
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
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2);
    user_1.open_subchannel_e2e(recipient: user_2, :token_address, index: 0);

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
    assert_eq!(decrypted_token, token_address);
}

#[test]
fn test_create_note_self_note() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user.open_channel_with_token_e2e(recipient: user, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user
        .new_note_with_generated_random(
            recipient: user, :token_address, :amount, index: note_index,
        );
    let actions = user.internal_create_note(:note);
    let expected_enc_note = user
        .compute_enc_note(
            recipient: user, :token_address, index: note_index, :amount, random: note.random,
        );
    assert_eq!(actions, expected_enc_note.to_server_actions());
}

#[test]
fn test_create_note_twice() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let amount_1 = 1;
    let note_index_1 = 0;
    let note_1 = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, amount: amount_1, index: note_index_1,
        );
    let create_note_1_actions = user_1.internal_create_note(note: note_1);
    let amount_2 = amount_1 + 1;
    let note_index_2 = note_index_1 + 1;
    user_1.privacy.execute_actions(actions: create_note_1_actions);
    let note_2 = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, amount: amount_2, index: note_index_2,
        );
    let create_note_2_actions = user_1.internal_create_note(note: note_2);
    let expected_note_1 = user_1
        .compute_enc_note(
            recipient: user_2,
            :token_address,
            index: note_index_1,
            amount: amount_1,
            random: note_1.random,
        );
    let expected_note_2 = user_1
        .compute_enc_note(
            recipient: user_2,
            :token_address,
            index: note_index_2,
            amount: amount_2,
            random: note_2.random,
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
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_index_1 = 0;
    let note_1 = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index_1,
        );
    let create_note_1_actions = user_1.internal_create_note(note: note_1);
    let note_index_2 = note_index_1 + 1;
    test.privacy.execute_actions(actions: create_note_1_actions);
    let note_2 = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index_2,
        );
    let create_note_2_actions = user_1.internal_create_note(note: note_2);
    let expected_enc_note_1 = user_1
        .compute_enc_note(
            recipient: user_2, :token_address, index: note_index_1, :amount, random: note_1.random,
        );
    let expected_enc_note_2 = user_1
        .compute_enc_note(
            recipient: user_2, :token_address, index: note_index_2, :amount, random: note_2.random,
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
    let token_address = test.mock_new_token();
    user_2.address = Zero::zero();
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, amount: 1, index: 0);
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
            recipient: user_2, token_address: Zero::zero(), amount: 1, index: 0,
        );
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'ZERO_AMOUNT')]
fn test_create_note_zero_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let token_address = test.mock_new_token();
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, amount: 0, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'ZERO_RANDOM')]
fn test_create_note_zero_random() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let token_address = test.mock_new_token();
    let note = user_1
        .new_note(recipient: user_2, :token_address, amount: 1, index: 0, random: Zero::zero());
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'ZERO_PRIVATE_KEY')]
fn test_create_note_zero_private_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    user_1.private_key = Zero::zero();
    let user_2 = test.new_user();
    let token_address = test.mock_new_token();
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'PRIVATE_KEY_NOT_CANONICAL')]
fn test_create_note_private_key_not_canonical() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    user_1.private_key = Neg::neg(user_1.private_key);
    let user_2 = test.new_user();
    let token_address = test.mock_new_token();
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'RANDOM_EXCEEDS_120_BITS')]
fn test_create_note_random_exceeds_120_bits() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let token_address = test.mock_new_token();
    let note = user_1
        .new_note(
            recipient: user_2,
            :token_address,
            amount: 1,
            index: 0,
            random: TWO_POW_120.try_into().unwrap(),
        );
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'ZERO_RECIPIENT_PUBLIC_KEY')]
fn test_create_note_zero_recipient_public_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let token_address = test.mock_new_token();
    let mut note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, amount: 1, index: 0);
    note.recipient_public_key = Zero::zero();
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'SUBCHANNEL_NOT_FOUND')]
fn test_create_note_subchannel_not_found_channel_doesnt_exist() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'SUBCHANNEL_NOT_FOUND')]
fn test_create_note_subchannel_not_found_subchannel_doesnt_exist() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2);
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'SUBCHANNEL_NOT_FOUND')]
fn test_create_note_subchannel_not_found_wrong_addr() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, amount: 1, index: 0);
    user_1.address = user_2.address;
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'SUBCHANNEL_NOT_FOUND')]
fn test_create_note_subchannel_not_found_wrong_private_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    user_1.new_key();
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'SUBCHANNEL_NOT_FOUND')]
fn test_create_note_subchannel_not_found_wrong_public_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    user_2.public_key = user_1.public_key;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'SUBCHANNEL_NOT_FOUND')]
fn test_create_note_subchannel_not_found_wrong_token() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let mut note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, amount: 1, index: 0);
    note.token = test.mock_new_token();
    user_1.create_note(:note);
}

#[should_panic(expected: 'INDEX_NOT_SEQUENTIAL')]
fn test_create_note_index_not_sequential() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let amount = 1;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, :amount, index: 1);
    user_1.create_note(:note);
}

#[test]
fn test_create_note_decrypt_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    let create_note_actions = user_1.internal_create_note(:note);
    user_1.privacy.execute_actions(actions: create_note_actions);

    // User 2 should be able to decrypt the amount.
    // Decrypt channel key.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (channel_key, _) = decrypt_channel_info(:enc_channel_info, private_key: user_2.private_key);
    let note_id = compute_note_id(:channel_key, token: token_address, index: note_index);
    let enc_amount = user_2.privacy.get_note(:note_id);
    let decrypted_amount = decrypt_note_amount(enc_note_value: enc_amount, :channel_key);
    assert_eq!(decrypted_amount, amount);
}

#[test]
#[feature("safe_dispatcher")]
fn test_deposit_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token_address = test.mock_new_token();
    let amount = 100;

    // Catch ZERO_TOKEN.
    let result = user.safe_deposit(token_address: Zero::zero(), :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT.
    let result = user.safe_deposit(:token_address, amount: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);
}

#[test]
fn test_use_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key, channel_key, token: token_address, note_index,
    };
    let actions = user_2.internal_use_note(note: use_note_input);
    let nullifier = user_2.compute_nullifier(sender: user_1, :token_address, :note_index);
    let nullifier_storage_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let expected_actions = [
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: nullifier_storage_path, value: true.into() },
        )
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_use_note_self_note() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user.open_channel_with_token_e2e(recipient: user, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user
        .new_note_with_generated_random(
            recipient: user, :token_address, :amount, index: note_index,
        );
    user.cheat_create_note_e2e(:note);
    let channel_key = user.compute_channel_key(recipient: user);
    let use_note_input = UseNoteInput {
        owner_private_key: user.private_key, channel_key, token: token_address, note_index,
    };
    let actions = user.internal_use_note(note: use_note_input);
    let nullifier = user.compute_nullifier(sender: user, :token_address, :note_index);
    let nullifier_storage_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let expected_actions = [
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: nullifier_storage_path, value: true.into() },
        )
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_use_note_multiple_notes() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_2.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let amount_1 = 1;
    let amount_2 = 2;
    let note_1 = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, amount: amount_1, index: 0,
        );
    let note_2 = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, amount: amount_2, index: 1,
        );
    let note_3 = user_2
        .new_note_with_generated_random(
            recipient: user_2, :token_address, amount: amount_1, index: 0,
        );
    user_1.cheat_create_note_e2e(note: note_1);
    user_1.cheat_create_note_e2e(note: note_2);
    user_2.cheat_create_note_e2e(note: note_3);
    let channel_key_1 = user_1.compute_channel_key(recipient: user_2);
    let channel_key_2 = user_2.compute_channel_key(recipient: user_2);
    let note_1_path = UseNoteInput {
        owner_private_key: user_2.private_key,
        channel_key: channel_key_1,
        token: token_address,
        note_index: 0,
    };
    let note_2_path = UseNoteInput {
        owner_private_key: user_2.private_key,
        channel_key: channel_key_1,
        token: token_address,
        note_index: 1,
    };
    let note_3_path = UseNoteInput {
        owner_private_key: user_2.private_key,
        channel_key: channel_key_2,
        token: token_address,
        note_index: 0,
    };
    let actions_1 = user_2.internal_use_note(note: note_1_path);
    let actions_2 = user_2.internal_use_note(note: note_2_path);
    let actions_3 = user_2.internal_use_note(note: note_3_path);
    let expected_nullifier_1 = user_2
        .compute_nullifier(sender: user_1, :token_address, note_index: 0);
    let expected_nullifier_2 = user_2
        .compute_nullifier(sender: user_1, :token_address, note_index: 1);
    let expected_nullifier_3 = user_2
        .compute_nullifier(sender: user_2, :token_address, note_index: 0);
    let nullifier_storage_path_1 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_1].span(),
    );
    let nullifier_storage_path_2 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_2].span(),
    );
    let nullifier_storage_path_3 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_3].span(),
    );
    let expected_actions_1 = [
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: nullifier_storage_path_1, value: true.into() },
        )
    ]
        .span();
    let expected_actions_2 = [
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: nullifier_storage_path_2, value: true.into() },
        )
    ]
        .span();
    let expected_actions_3 = [
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: nullifier_storage_path_3, value: true.into() },
        )
    ]
        .span();
    assert_eq!(actions_1, expected_actions_1);
    assert_eq!(actions_2, expected_actions_2);
    assert_eq!(actions_3, expected_actions_3);
}

#[test]
#[should_panic(expected: 'NON_ZERO_VALUE')]
fn test_use_same_note_twice() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key, channel_key, token: token_address, note_index,
    };
    let use_note_action = ClientAction::UseNote(use_note_input);
    let client_actions = [use_note_action, use_note_action].span();
    // Should panic on the second use.
    user_2.compile_client_actions(:client_actions);
}

#[test]
fn test_use_note_same_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_1 = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, :amount, index: 0);
    let note_2 = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, :amount, index: 1);
    user_1.cheat_create_note_e2e(note: note_1);
    user_1.cheat_create_note_e2e(note: note_2);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input_1 = UseNoteInput {
        owner_private_key: user_2.private_key, channel_key, token: token_address, note_index: 0,
    };
    let use_note_input_2 = UseNoteInput {
        owner_private_key: user_2.private_key, channel_key, token: token_address, note_index: 1,
    };
    let actions_1 = user_2.internal_use_note(note: use_note_input_1);
    let actions_2 = user_2.internal_use_note(note: use_note_input_2);
    let expected_nullifier_1 = user_2
        .compute_nullifier(sender: user_1, :token_address, note_index: 0);
    let expected_nullifier_2 = user_2
        .compute_nullifier(sender: user_1, :token_address, note_index: 1);
    let nullifier_storage_path_1 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_1].span(),
    );
    let nullifier_storage_path_2 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_2].span(),
    );
    let expected_actions_1 = [
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: nullifier_storage_path_1, value: true.into() },
        )
    ]
        .span();
    let expected_actions_2 = [
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: nullifier_storage_path_2, value: true.into() },
        )
    ]
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
    let use_note_input = UseNoteInput {
        owner_private_key: user_1.private_key, channel_key, token: Zero::zero(), note_index: 0,
    };
    user_1.use_note(note: use_note_input);
}

#[test]
#[should_panic(expected: 'ZERO_CHANNEL_KEY')]
fn test_use_note_zero_channel_key() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let token_address = test.mock_new_token();
    let use_note_input = UseNoteInput {
        owner_private_key: user_1.private_key,
        channel_key: Zero::zero(),
        token: token_address,
        note_index: 0,
    };
    user_1.use_note(note: use_note_input);
}

#[test]
#[should_panic(expected: 'ZERO_PRIVATE_KEY')]
fn test_use_note_zero_private_key() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let token_address = test.mock_new_token();
    let channel_key = user_1.compute_channel_key(recipient: user_1);
    let use_note_input = UseNoteInput {
        owner_private_key: Zero::zero(), channel_key, token: token_address, note_index: 0,
    };
    user_1.use_note(note: use_note_input);
}

#[test]
#[should_panic(expected: 'PRIVATE_KEY_NOT_CANONICAL')]
fn test_use_note_private_key_not_canonical() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let token_address = test.mock_new_token();
    let channel_key = user_1.compute_channel_key(recipient: user_1);
    let use_note_input = UseNoteInput {
        owner_private_key: Neg::neg(user_1.private_key),
        channel_key,
        token: token_address,
        note_index: 0,
    };
    user_1.use_note(note: use_note_input);
}

#[test]
#[should_panic(expected: 'SUBCHANNEL_NOT_FOUND')]
fn test_use_note_wrong_owner_addr() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    user_2.open_channel_e2e(recipient: user_1);
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, amount: 1, index: 0);
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key, channel_key, token: token_address, note_index: 0,
    };
    user_2.address = user_1.address;
    user_2.use_note(note: use_note_input);
}

#[test]
#[should_panic(expected: 'SUBCHANNEL_NOT_FOUND')]
fn test_use_note_wrong_owner_private_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    user_2.new_key();
    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key, channel_key, token: token_address, note_index,
    };
    user_2.use_note(note: use_note_input);
}

#[test]
#[should_panic(expected: 'NOTE_NOT_FOUND')]
fn test_use_note_wrong_note_index() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key,
        channel_key,
        token: token_address,
        note_index: note_index + 1,
    };
    user_2.use_note(note: use_note_input);
}

#[test]
#[should_panic(expected: 'SUBCHANNEL_NOT_FOUND')]
fn test_use_note_wrong_channel_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2);
    user_2.open_channel_e2e(recipient: user_2);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);
    let wrong_channel_key = user_1.compute_channel_key(recipient: user_1);
    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key,
        channel_key: wrong_channel_key,
        token: token_address,
        note_index,
    };
    user_2.use_note(note: use_note_input);
}

#[test]
#[should_panic(expected: 'SUBCHANNEL_NOT_FOUND')]
fn test_use_note_wrong_token() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let wrong_token_address = test.mock_new_token();
    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key, channel_key, token: wrong_token_address, note_index,
    };
    user_2.use_note(note: use_note_input);
}

#[test]
fn test_use_note_find_nullifier() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_address, subchannel_index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);

    // User 2 should be able to find the nullifier.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (channel_key, _) = decrypt_channel_info(:enc_channel_info, private_key: user_2.private_key);
    let expected_nullifier = compute_nullifier(
        :channel_key,
        token: token_address,
        index: note_index,
        owner_private_key: user_2.private_key,
    );
    assert!(!user_2.privacy.nullifier_exists(nullifier: expected_nullifier));

    // User 2 uses the note.
    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key, channel_key, token: token_address, note_index,
    };
    let actions = user_2.internal_use_note(note: use_note_input);
    let nullifier_storage_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let expected_actions = [
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: nullifier_storage_path, value: true.into() },
        )
    ]
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
    let token_address = test.mock_new_token();
    let amount = 100;

    // Setup users.
    let mut user_1 = test.new_user(); // Owner.
    let mut user_2 = test.new_user(); // Registered user.
    let user_3 = test.new_user(); // Not registered.
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_1, :token_address, subchannel_index: 0);

    // Withdraw note to self.
    let actions = user_1
        .internal_withdraw(withdrawal_target: user_1.address, :token_address, :amount);
    let expected_actions = [
        ServerAction::TransferTo(
            TransferToInput {
                recipient_addr: user_1.address, token: token_address, amount: amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Withdraw note to other registered user.
    let actions = user_1
        .internal_withdraw(withdrawal_target: user_2.address, :token_address, :amount);
    let expected_actions = [
        ServerAction::TransferTo(
            TransferToInput {
                recipient_addr: user_2.address, token: token_address, amount: amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Withdraw note to not registered user.
    let actions = user_1
        .internal_withdraw(withdrawal_target: user_3.address, :token_address, :amount);
    let expected_actions = [
        ServerAction::TransferTo(
            TransferToInput {
                recipient_addr: user_3.address, token: token_address, amount: amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
#[feature("safe_dispatcher")]
fn test_withdraw_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_address = test.mock_new_token();
    let amount = 100;

    // Catch ZERO_WITHDRAWAL_TARGET.
    let result = user_1.safe_withdraw(withdrawal_target: Zero::zero(), :token_address, :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_WITHDRAWAL_TARGET);

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_withdraw(withdrawal_target: user_2.address, token_address: Zero::zero(), :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT.
    let result = user_1
        .safe_withdraw(withdrawal_target: user_2.address, :token_address, amount: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);
}

#[test]
fn test_set_viewing_key_to_other_user_key() {
    let mut test: Test = Default::default();
    let mut user1 = test.new_user();
    let mut user2 = test.new_user();
    let user2_public_key = user2.public_key;

    // Register user2.
    user2.set_viewing_key_e2e();

    // Verify initial keys.
    assert_eq!(user2.get_public_key(), user2_public_key);

    // User1 sets their viewing key to user2's viewing key.
    user1.private_key = user2.private_key;
    user1.set_viewing_key_e2e();

    // Verify user1 now has user2's public key.
    assert_eq!(user1.get_public_key(), user2_public_key);
    // Verify user2's key is unchanged.
    assert_eq!(user2.get_public_key(), user2_public_key);
}

#[test]
fn test_compile_client_actions_empty() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();

    let mut spy = spy_messages_to_l1();
    user_1.compile_client_actions(client_actions: [].span());
    test.privacy.general_assert_spy_messages(ref :spy);
    let actions = spy_messages_to_server_actions(ref :spy);
    let expected_actions = [].span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_compile_client_actions_set_viewing_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();

    let random = user_1.get_random().into();
    let mut spy = spy_messages_to_l1();
    user_1
        .compile_client_actions(
            client_actions: [
                ClientAction::SetViewingKey(
                    SetViewingKeyInput { private_key: user_1.private_key, random },
                )
            ]
                .span(),
        );
    test.privacy.general_assert_spy_messages(ref :spy);
    let actions = spy_messages_to_server_actions(ref :spy);
    let enc_private_key = user_1.compute_enc_private_key(:random);
    let public_key_storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user_1.address.into()].span(),
    );
    let enc_private_key_storage_path_felt = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [user_1.address.into()].span(),
    );
    let expected_actions = [
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: public_key_storage_path_felt, value: user_1.public_key,
            },
        ),
        ServerAction::WriteIfZeroPrivateKey(
            WriteIfZeroPrivateKeyInput {
                storage_address: enc_private_key_storage_path_felt, value: enc_private_key,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert_eq!(user_1.get_public_key(), user_1.public_key);
    assert_eq!(user_1.get_enc_private_key(), enc_private_key);
}

#[test]
fn test_compile_client_actions_open_channel() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();

    // Open channel action.
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let random = user_1.get_random().into();
    let mut spy = spy_messages_to_l1();
    user_1
        .compile_client_actions(
            client_actions: [
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        sender_private_key: user_1.private_key,
                        recipient_addr: user_2.address,
                        recipient_public_key: user_2.public_key,
                        random,
                    },
                )
            ]
                .span(),
        );
    test.privacy.general_assert_spy_messages(ref :spy);
    let actions = spy_messages_to_server_actions(ref :spy);
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
        ServerAction::VerifyValue(
            VerifyValueInput {
                storage_address: recipient_public_key_storage_path, value: user_2.public_key,
            },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: channel_exists_storage_path, value: true.into() },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user_2.address,
                recipient_public_key: user_2.public_key,
                enc_channel_info: expected_enc_channel_info,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(test.privacy.channel_exists(channel_id: expected_channel_id));
    assert_eq!(user_2.get_num_of_channels(), 1);
    assert_eq!(user_2.get_channel_info(channel_index: 0), expected_enc_channel_info);
    assert_eq!(user_1.get_num_of_channels(), 0);
}

#[test]
fn test_compile_client_actions_open_subchannel() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_address = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let random = user_1.open_channel_e2e(recipient: user_2);

    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let mut spy = spy_messages_to_l1();
    user_1
        .compile_client_actions(
            client_actions: [
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user_2.address,
                        recipient_public_key: user_2.public_key,
                        channel_key,
                        index: 0,
                        token: token_address,
                        random,
                    },
                ),
            ]
                .span(),
        );
    test.privacy.general_assert_spy_messages(ref :spy);
    let actions = spy_messages_to_server_actions(ref :spy);
    let expected_subchannel_id = user_1.compute_subchannel_id(recipient: user_2, :token_address);
    let expected_subchannel_key = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_enc_subchannel_info = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_address, :random);
    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: subchannel_exists_storage_path_felt, value: true.into(),
            },
        ),
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroSubchannelInput {
                storage_address: subchannel_tokens_storage_path_felt,
                value: expected_enc_subchannel_info,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(test.privacy.subchannel_exists(subchannel_id: expected_subchannel_id));
    assert_eq!(
        test.privacy.get_subchannel_info(subchannel_key: expected_subchannel_key),
        expected_enc_subchannel_info,
    );
}

#[test]
fn test_compile_client_actions_deposit_create_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_address = token.contract_address();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2);

    let amount = 100;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, :amount, index: 0);
    user_1.open_subchannel_e2e(recipient: user_2, :token_address, index: 0);
    user_1.increase_token_balance(:token, :amount);
    user_1.approve(:token, amount: amount.into());
    let mut spy = spy_messages_to_l1();
    user_1
        .compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::CreateNote(note),
            ]
                .span(),
        );
    test.privacy.general_assert_spy_messages(ref :spy);
    let actions = spy_messages_to_server_actions(ref :spy);
    let expected_enc_note = user_1
        .compute_enc_note(
            recipient: user_2, :token_address, index: 0, :amount, random: note.random,
        );
    let note_storage_path = map_entry_address(
        map_selector: selector!("notes"), keys: [expected_enc_note.id].span(),
    );
    let expected_actions = array![
        ServerAction::TransferFrom(
            TransferFromInput {
                sender_addr: user_1.address, token: token_address, amount: amount.into(),
            },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: note_storage_path, value: expected_enc_note.enc_amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert_eq!(test.privacy.get_note(note_id: expected_enc_note.id), expected_enc_note.enc_amount);
}

#[test]
fn test_compile_client_actions_deposit_withdraw() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_address = token.contract_address();

    let amount = 100;
    user_1.increase_token_balance(:token, :amount);
    user_1.approve(:token, amount: amount.into());
    let mut spy = spy_messages_to_l1();
    user_1
        .compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput {
                        withdrawal_target: user_2.address, token: token_address, amount,
                    },
                ),
            ]
                .span(),
        );
    test.privacy.general_assert_spy_messages(ref :spy);
    let actions = spy_messages_to_server_actions(ref :spy);
    let expected_actions = array![
        ServerAction::TransferFrom(
            TransferFromInput {
                sender_addr: user_1.address, token: token_address, amount: amount.into(),
            },
        ),
        ServerAction::TransferTo(
            TransferToInput {
                recipient_addr: user_2.address, token: token_address, amount: amount.into(),
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_compile_client_actions_use_note_create_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_address = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2);
    user_1.open_subchannel_e2e(recipient: user_2, :token_address, index: 0);

    let amount = 100;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, :amount, index: 0);
    user_1.cheat_create_note_e2e(:note);
    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key,
        channel_key: user_1.compute_channel_key(recipient: user_2),
        token: token_address,
        note_index: note.index,
    };
    let create_note_input = user_2
        .new_note_with_generated_random(recipient: user_1, :token_address, :amount, index: 0);
    user_2.open_channel_e2e(recipient: user_1);
    user_2.open_subchannel_e2e(recipient: user_1, :token_address, index: 0);
    let mut spy = spy_messages_to_l1();
    user_2
        .compile_client_actions(
            client_actions: [
                ClientAction::UseNote(use_note_input), ClientAction::CreateNote(create_note_input),
            ]
                .span(),
        );
    test.privacy.general_assert_spy_messages(ref :spy);
    let actions = spy_messages_to_server_actions(ref :spy);
    let expected_enc_note = user_2
        .compute_enc_note(
            recipient: user_1,
            :token_address,
            index: create_note_input.index,
            :amount,
            random: create_note_input.random,
        );
    let note_storage_path = map_entry_address(
        map_selector: selector!("notes"), keys: [expected_enc_note.id].span(),
    );
    let nullifier = user_2
        .compute_nullifier(sender: user_1, :token_address, note_index: note.index);
    let nullifier_storage_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: nullifier_storage_path, value: true.into() },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: note_storage_path, value: expected_enc_note.enc_amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(test.privacy.nullifier_exists(:nullifier));
    assert_eq!(test.privacy.get_note(note_id: expected_enc_note.id), expected_enc_note.enc_amount);
}

#[test]
fn test_compile_client_actions_use_note_withdraw() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_address = token.contract_address();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2);
    user_1.open_subchannel_e2e(recipient: user_2, :token_address, index: 0);
    let amount = 100;
    let note = user_1
        .new_note_with_generated_random(recipient: user_2, :token_address, :amount, index: 0);
    user_1.cheat_create_note_e2e(:note);
    test.privacy.increase_token_balance(:token, :amount);

    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key,
        channel_key: user_1.compute_channel_key(recipient: user_2),
        token: token_address,
        note_index: note.index,
    };
    let mut spy = spy_messages_to_l1();
    user_2
        .compile_client_actions(
            client_actions: [
                ClientAction::UseNote(use_note_input),
                ClientAction::Withdraw(
                    WithdrawInput {
                        withdrawal_target: user_1.address, token: token_address, amount,
                    },
                ),
            ]
                .span(),
        );
    test.privacy.general_assert_spy_messages(ref :spy);
    let actions = spy_messages_to_server_actions(ref :spy);
    let nullifier = user_2
        .compute_nullifier(sender: user_1, :token_address, note_index: note.index);
    let nullifier_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let expected_actions = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: nullifier_path, value: true.into() },
        ),
        ServerAction::TransferTo(
            TransferToInput {
                recipient_addr: user_1.address, token: token_address, amount: amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(test.privacy.nullifier_exists(:nullifier));
}

#[test]
fn test_internal_actions() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_address = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2);

    // TODO: Add missing actions here.

    // Create note action.
    let amount = 1;
    let note_index = 0;
    let subchannel_index = 0;
    let note = user_1
        .new_note_with_generated_random(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    user_1.open_subchannel_e2e(recipient: user_2, :token_address, index: subchannel_index);
    let actions = user_1.internal_create_note(:note);
    let expected_enc_note = user_1
        .compute_enc_note(
            recipient: user_2, :token_address, index: note_index, :amount, random: note.random,
        );
    assert_eq!(actions, expected_enc_note.to_server_actions());

    // Deposit action.
    let actions = user_1.internal_deposit(:token_address, :amount);
    let expected_actions = [
        ServerAction::TransferFrom(
            TransferFromInput { sender_addr: user_1.address, token: token_address, amount: amount },
        )
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Use note action.
    user_1.cheat_create_note_e2e(:note);
    let nullifier = user_2.compute_nullifier(sender: user_1, :token_address, :note_index);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key, channel_key, token: token_address, note_index,
    };
    let actions = user_2.internal_use_note(note: use_note_input);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let expected_actions = [
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt_nullifier, value: true.into() },
        )
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Withdraw action.
    let actions = user_2
        .internal_withdraw(withdrawal_target: user_1.address, :token_address, :amount);
    let expected_actions = [
        ServerAction::TransferTo(
            TransferToInput {
                recipient_addr: user_1.address, token: token_address, amount: amount,
            },
        )
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

// TODO: Fix this test. Now failing because storage writings are not reverted when panicking.
#[test]
#[ignore]
fn test_compile_client_actions_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token_address = test.mock_new_token();
    let amount = 100;
    user.set_viewing_key_e2e();
    let note_1 = user
        .new_note_with_generated_random(recipient: user, :token_address, :amount, index: 0);
    let note_1_path = UseNoteInput {
        owner_private_key: user.private_key,
        channel_key: user.compute_channel_key(recipient: user),
        token: token_address,
        note_index: 0,
    };
    let note_2 = CreateNoteInput { index: 1, ..note_1 };

    // TODO: Catch INVALID_SIGNATURE.

    // TODO: Catch server errors.

    // Catch INVALID_CALLER.
    let result = user.safe_compile_client_actions_without_cheat_caller(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CALLER);

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_compile_client_actions(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch ACTIONS_OUT_OF_ORDER (set viewing key twice).
    let random = user.get_random().into();
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::SetViewingKey(
                    SetViewingKeyInput { private_key: user.private_key, random },
                ),
                ClientAction::SetViewingKey(
                    SetViewingKeyInput { private_key: user.private_key, random },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (open channel -> set viewing key).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        sender_private_key: user.private_key,
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        random,
                    },
                ),
                ClientAction::SetViewingKey(
                    SetViewingKeyInput { private_key: user.private_key, random },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (open subchannel -> set viewing key).
    user.open_channel_e2e(recipient: user);
    let channel_key = user.compute_channel_key(recipient: user);
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key,
                        index: 0,
                        token: token_address,
                        random,
                    },
                ),
                ClientAction::SetViewingKey(
                    SetViewingKeyInput { private_key: user.private_key, random },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (open subchannel -> open channel).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key,
                        index: 0,
                        token: token_address,
                        random,
                    },
                ),
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        sender_private_key: user.private_key,
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        random,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (deposit -> set viewing key).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::SetViewingKey(
                    SetViewingKeyInput { private_key: user.private_key, random },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (deposit -> open channel).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        sender_private_key: user.private_key,
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        random,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (deposit -> open subchannel).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key,
                        index: 0,
                        token: token_address,
                        random,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (use note -> set viewing key).
    user.open_subchannel_e2e(recipient: user, :token_address, index: 0);
    user.cheat_create_note_e2e(note: note_1);
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::UseNote(note_1_path),
                ClientAction::SetViewingKey(
                    SetViewingKeyInput { private_key: user.private_key, random },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (use note -> open channel).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::UseNote(note_1_path),
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        sender_private_key: user.private_key,
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        random,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (use note -> open subchannel).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::UseNote(note_1_path),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key,
                        index: 0,
                        token: token_address,
                        random,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (use note -> deposit).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::UseNote(note_1_path),
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create note -> set viewing key).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::CreateNote(note_2),
                ClientAction::SetViewingKey(
                    SetViewingKeyInput { private_key: user.private_key, random },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create note -> open channel).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::CreateNote(note_2),
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        sender_private_key: user.private_key,
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        random,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create note -> open subchannel).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::CreateNote(note_2),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key,
                        index: 0,
                        token: token_address,
                        random,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create note -> deposit).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::CreateNote(note_2),
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create note -> use note).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::CreateNote(note_2), ClientAction::UseNote(note_1_path),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> set viewing key).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput { withdrawal_target: user.address, token: token_address, amount },
                ),
                ClientAction::SetViewingKey(
                    SetViewingKeyInput { private_key: user.private_key, random },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> open channel).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput { withdrawal_target: user.address, token: token_address, amount },
                ),
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        sender_private_key: user.private_key,
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        random,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> open subchannel).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput { withdrawal_target: user.address, token: token_address, amount },
                ),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key,
                        index: 0,
                        token: token_address,
                        random,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> deposit).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput { withdrawal_target: user.address, token: token_address, amount },
                ),
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> use note).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput { withdrawal_target: user.address, token: token_address, amount },
                ),
                ClientAction::UseNote(note_1_path),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> create note).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput { withdrawal_target: user.address, token: token_address, amount },
                ),
                ClientAction::CreateNote(note_2),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch FINAL_BALANCE_MUST_BE_ZERO (deposit).
    let result = user
        .safe_compile_client_actions(
            client_actions: [ClientAction::Deposit(DepositInput { token: token_address, amount }),]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::FINAL_BALANCE_MUST_BE_ZERO);

    // Catch FINAL_BALANCE_MUST_BE_ZERO (use note).
    let result = user
        .safe_compile_client_actions(client_actions: [ClientAction::UseNote(note_1_path),].span());
    assert_panic_with_felt_error(:result, expected_error: errors::FINAL_BALANCE_MUST_BE_ZERO);

    // Catch NEGATIVE_INTERMEDIATE_BALANCE (withdraw).
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Withdraw(
                    WithdrawInput { withdrawal_target: user.address, token: token_address, amount },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);

    // Catch NEGATIVE_INTERMEDIATE_BALANCE (create note).
    let result = user
        .safe_compile_client_actions(client_actions: [ClientAction::CreateNote(note_2),].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);

    // Catch NEGATIVE_INTERMEDIATE_BALANCE (wrong order)
    let result = user
        .safe_compile_client_actions(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput {
                        withdrawal_target: user.address, token: token_address, amount: 2 * amount,
                    },
                ),
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);
}
// TODO: Test with the negative private key (not canonical but the right public key) for each action
// that gets a private key as an input.

#[test]
fn test_compile_client_actions_writes() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let token_address = token.contract_address();
    let amount = 100;
    let private_key = user.private_key;
    let random = user.get_random();
    let recipient_addr = user.address;
    let recipient_public_key = user.public_key;
    let channel_key = user.compute_channel_key(recipient: user);
    let index = 0;
    let set_viewing_key = ClientAction::SetViewingKey(
        SetViewingKeyInput { private_key, random: random.into() },
    );
    let open_channel = ClientAction::OpenChannel(
        OpenChannelInput {
            sender_private_key: private_key,
            recipient_addr,
            recipient_public_key,
            random: random.into(),
        },
    );
    let open_subchannel = ClientAction::OpenSubchannel(
        OpenSubchannelInput {
            recipient_addr,
            recipient_public_key,
            channel_key,
            index,
            token: token_address,
            random: random.into(),
        },
    );
    let deposit = ClientAction::Deposit(DepositInput { token: token_address, amount });
    let create_note = ClientAction::CreateNote(
        CreateNoteInput {
            sender_private_key: private_key,
            recipient_addr,
            recipient_public_key,
            token: token_address,
            amount,
            index,
            random,
        },
    );
    let client_actions = [set_viewing_key, open_channel, open_subchannel, deposit, create_note]
        .span();
    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());
    // Compile client actions.
    let mut spy = spy_messages_to_l1();
    user.compile_client_actions(:client_actions);
    test.privacy.general_assert_spy_messages(ref :spy);
    let server_actions = spy_messages_to_server_actions(ref :spy);
    // Expected server actions.
    let address = user.address;
    let public_key_storage_path = map_entry_address(
        map_selector: selector!("public_key"), keys: [address.into()].span(),
    );
    let enc_private_key_storage_path = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [address.into()].span(),
    );
    let public_key = user.public_key;
    let enc_private_key = user.compute_enc_private_key(random: random.into());
    let channel_id = user.compute_channel_id(recipient: user);
    let channel_exists_storage_path = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [channel_id].span(),
    );
    let enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random.into(), :recipient_public_key, :channel_key, sender_addr: address,
    );
    let subchannel_id = user.compute_subchannel_id(recipient: user, :token_address);
    let subchannel_exists_storage_path = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [subchannel_id].span(),
    );
    let subchannel_key = user.compute_subchannel_key(recipient: user, :index);
    let subchannel_tokens_storage_path = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [subchannel_key].span(),
    );
    let enc_subchannel_info = user
        .compute_enc_subchannel_info(recipient: user, :token_address, random: random.into());
    let enc_note = user.compute_enc_note(recipient: user, :token_address, :index, :amount, :random);
    let note_storage_path = map_entry_address(
        map_selector: selector!("notes"), keys: [enc_note.id].span(),
    );
    let expected_sevrer_actions = [
        // Set viewing key.
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: public_key_storage_path, value: public_key },
        ),
        ServerAction::WriteIfZeroPrivateKey(
            WriteIfZeroPrivateKeyInput {
                storage_address: enc_private_key_storage_path, value: enc_private_key,
            },
        ),
        // Open channel.
        ServerAction::VerifyValue(
            VerifyValueInput { storage_address: public_key_storage_path, value: public_key },
        ),
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: channel_exists_storage_path, value: true.into() },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: address, recipient_public_key: public_key, enc_channel_info,
            },
        ),
        // Open subchannel.
        ServerAction::WriteIfZero(
            WriteIfZeroInput {
                storage_address: subchannel_exists_storage_path, value: true.into(),
            },
        ),
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroSubchannelInput {
                storage_address: subchannel_tokens_storage_path, value: enc_subchannel_info,
            },
        ),
        // Deposit.
        ServerAction::TransferFrom(
            TransferFromInput { sender_addr: address, token: token_address, amount: amount.into() },
        ),
        // Create note.
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: note_storage_path, value: enc_note.enc_amount },
        ),
    ]
        .span();
    // Assert server actions.
    assert_eq!(server_actions, expected_sevrer_actions);
}
