use core::num::traits::Zero;
use privacy::actions::{
    AppendToVecInput, ClientAction, CreateNoteInput, DepositInput, OpenChannelInput,
    OpenSubchannelInput, ServerAction, SetViewingKeyInput, TransferFromInput, TransferToInput,
    UseNoteInput, VerifyValueInput, WithdrawInput, WriteOnceInput,
};
use privacy::hashes::{compute_note_id, compute_nullifier, compute_subchannel_key};
use privacy::objects::{EncUserAddr, ToServerActionsTrait};
use privacy::tests::utils_for_tests::{
    PrivacyCfgTrait, PrivacyTokenTrait, Test, TestTrait, UserTrait, decrypt_channel_info,
    decrypt_enc_user_addr, decrypt_outgoing_channel_info, decrypt_private_key,
    decrypt_subchannel_token,
};
use privacy::utils::constants::TWO_POW_120;
use privacy::utils::{decrypt_note_amount, encrypt_channel_info, is_canonical_key};
use privacy::{errors, events};
use snforge_std::{
    CheatSpan, EventSpyTrait, EventsFilterTrait, TokenTrait, cheat_tip, cheat_transaction_version,
    map_entry_address, spy_events,
};
use starknet::VALIDATED;
use starkware_utils::erc20::erc20_errors::Erc20Error;
use starkware_utils::errors::Describable;
use starkware_utils_testing::test_utils::{
    assert_expected_event_emitted, assert_panic_with_error, assert_panic_with_felt_error,
};

// TODO: Catch server errors in the client side.

#[test]
fn test_validate() {
    let mut test: Test = Default::default();
    let validated = test.privacy.validate(user_addr: Zero::zero(), client_actions: [].span());
    assert_eq!(validated, VALIDATED);
    let mut user = test.new_user();
    let client_actions = [
        ClientAction::SetViewingKey(
            SetViewingKeyInput { private_key: user.private_key, random: user.get_random() },
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
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: public_key_storage_path_felt, value: [public_key].span(),
            },
        ),
        enc_private_key.to_write_once_action(storage_address: enc_private_key_storage_path_felt),
        ServerAction::EmitViewingKeySet(
            events::ViewingKeySet {
                user_addr: user.address, public_key: user.public_key, enc_private_key,
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
    let random = user.get_random();

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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    user_1
        .open_channel_with_token_e2e(
            recipient: user_1, :token_address, outgoing_channel_index: 1, subchannel_index: 0,
        );
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_salt(
            recipient: user_1, :token_address, :amount, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_1);

    let use_note_input = UseNoteInput {
        owner_private_key: user_1.private_key, channel_key, token: token_address, note_index,
    };
    let note = user_1
        .new_note_with_generated_salt(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    let actions = user_1
        .transfer(notes_to_use: [use_note_input].span(), notes_to_create: [note].span());

    let expected_nullifier = user_1.compute_nullifier(sender: user_1, :token_address, :note_index);
    let (note_id, expected_note) = user_1.compute_note(:note);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let expected_actions = array![
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: storage_path_felt_nullifier, value: [true.into()].span(),
            },
        ),
        user_1.note_to_server_action(:note),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    test.privacy.execute_actions(:actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(:note_id), expected_note.enc_value);
}

#[test]
fn test_transfer_to_self() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_1, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    user_2
        .open_channel_with_token_e2e(
            recipient: user_1, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount = 1;
    let note_index = 0;
    let note = user_2
        .new_note_with_generated_salt(
            recipient: user_1, :token_address, :amount, index: note_index,
        );
    user_2.cheat_create_note_e2e(:note);
    let channel_key = user_2.compute_channel_key(recipient: user_1);

    let use_note_input = UseNoteInput {
        owner_private_key: user_1.private_key, channel_key, token: token_address, note_index,
    };
    let note = user_1
        .new_note_with_generated_salt(
            recipient: user_1, :token_address, :amount, index: note_index,
        );

    let actions = user_1
        .transfer(notes_to_use: [use_note_input].span(), notes_to_create: [note].span());
    let expected_nullifier = user_1.compute_nullifier(sender: user_2, :token_address, :note_index);
    let (note_id, expected_note) = user_1.compute_note(:note);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let expected_actions = array![
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: storage_path_felt_nullifier, value: [true.into()].span(),
            },
        ),
        user_1.note_to_server_action(:note),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    test.privacy.execute_actions(:actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(:note_id), expected_note.enc_value);
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    user_1
        .open_channel_with_token_e2e(
            recipient: user_3, :token_address, outgoing_channel_index: 1, subchannel_index: 0,
        );
    user_1
        .open_channel_with_token_e2e(
            recipient: user_1, :token_address, outgoing_channel_index: 2, subchannel_index: 0,
        );
    let note_index = 0;
    let amount_1 = 1;
    let amount_2 = 8;
    let note = user_1
        .new_note_with_generated_salt(
            recipient: user_1, :token_address, amount: amount_1 + amount_2, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);
    let channel_key = user_1.compute_channel_key(recipient: user_1);

    let use_note_input = UseNoteInput {
        owner_private_key: user_1.private_key, channel_key, token: token_address, note_index,
    };
    let note_1 = user_1
        .new_note_with_generated_salt(
            recipient: user_2, :token_address, amount: amount_1, index: note_index,
        );
    let note_2 = user_1
        .new_note_with_generated_salt(
            recipient: user_3, :token_address, amount: amount_2, index: note_index,
        );

    let actions = user_1
        .transfer(notes_to_use: [use_note_input].span(), notes_to_create: [note_1, note_2].span());
    let expected_nullifier = user_1.compute_nullifier(sender: user_1, :token_address, :note_index);
    let (note_id_1, expected_note_1) = user_1.compute_note(note: note_1);
    let (note_id_2, expected_note_2) = user_1.compute_note(note: note_2);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let expected_actions = array![
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: storage_path_felt_nullifier, value: [true.into()].span(),
            },
        ),
        user_1.note_to_server_action(note: note_1), user_1.note_to_server_action(note: note_2),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(note_id: note_id_1), Zero::zero());
    assert_eq!(test.privacy.get_note(note_id: note_id_2), Zero::zero());

    test.privacy.execute_actions(:actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(note_id: note_id_1), expected_note_1.enc_value);
    assert_eq!(test.privacy.get_note(note_id: note_id_2), expected_note_2.enc_value);
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    user_2
        .open_channel_with_token_e2e(
            recipient: user_1, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    user_3
        .open_channel_with_token_e2e(
            recipient: user_1, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount = 1;
    let note_index = 0;
    let note = user_2
        .new_note_with_generated_salt(
            recipient: user_1, :token_address, :amount, index: note_index,
        );
    user_2.cheat_create_note_e2e(:note);
    let channel_key_1 = user_2.compute_channel_key(recipient: user_1);
    let note = user_3
        .new_note_with_generated_salt(
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
        .new_note_with_generated_salt(
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
    let (note_id, expected_note) = user_1.compute_note(:note);
    let storage_path_felt_nullifier_1 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_1].span(),
    );
    let storage_path_felt_nullifier_2 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_2].span(),
    );
    let expected_actions = array![
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: storage_path_felt_nullifier_1, value: [true.into()].span(),
            },
        ),
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: storage_path_felt_nullifier_2, value: [true.into()].span(),
            },
        ),
        user_1.note_to_server_action(:note),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier_1));
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier_2));
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    test.privacy.execute_actions(:actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier_1));
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier_2));
    assert_eq!(test.privacy.get_note(:note_id), expected_note.enc_value);
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_3, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    user_2
        .open_channel_with_token_e2e(
            recipient: user_3, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    user_3
        .open_channel_with_token_e2e(
            recipient: user_1, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    user_3
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 1, subchannel_index: 0,
        );
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_salt(
            recipient: user_3, :token_address, :amount, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);
    let channel_key_1 = user_1.compute_channel_key(recipient: user_3);
    let note = user_2
        .new_note_with_generated_salt(
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
        .new_note_with_generated_salt(
            recipient: user_1, :token_address, :amount, index: note_index,
        );
    let note_2 = user_3
        .new_note_with_generated_salt(
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
    let (note_id_1, expected_note_1) = user_3.compute_note(note: note_1);
    let (note_id_2, expected_note_2) = user_3.compute_note(note: note_2);
    assert_ne!(note_id_1, note_id_2);
    assert_ne!(expected_note_1.enc_value, expected_note_2.enc_value);
    let storage_path_felt_nullifier_1 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_1].span(),
    );
    let storage_path_felt_nullifier_2 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_2].span(),
    );
    let expected_actions = array![
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: storage_path_felt_nullifier_1, value: [true.into()].span(),
            },
        ),
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: storage_path_felt_nullifier_2, value: [true.into()].span(),
            },
        ),
        user_3.note_to_server_action(note: note_1), user_3.note_to_server_action(note: note_2),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier_1));
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier_2));
    assert_eq!(test.privacy.get_note(note_id: note_id_1), Zero::zero());
    assert_eq!(test.privacy.get_note(note_id: note_id_2), Zero::zero());

    test.privacy.execute_actions(:actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier_1));
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier_2));
    assert_eq!(test.privacy.get_note(note_id: note_id_1), expected_note_1.enc_value);
    assert_eq!(test.privacy.get_note(note_id: note_id_2), expected_note_2.enc_value);
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
        salt: user_1.get_salt(),
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
    user_1.open_channel_e2e(recipient: user_1, index: 0);

    // Catch SUBCHANNEL_NOT_FOUND - subchannel doesnt exist.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    user_1.open_subchannel_e2e(recipient: user_1, :token_address, index: 0);

    // Catch SUBCHANNEL_NOT_FOUND - wrong address.
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 1);
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
        .new_note_with_generated_salt(recipient: user_1, :token_address, amount: 1, index: 0);
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

    // Catch SALT_TOO_SMALL.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateNoteInput { salt: 0, ..create_note_input }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SALT_TOO_SMALL);
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateNoteInput { salt: 1, ..create_note_input }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SALT_TOO_SMALL);

    // Catch SALT_EXCEEDS_120_BITS.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [
                CreateNoteInput { salt: TWO_POW_120.try_into().unwrap(), ..create_note_input }
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SALT_EXCEEDS_120_BITS);

    // Note: ZERO_SENDER_PRIVATE_KEY is already caught in use_note.
    // Note: PRIVATE_KEY_NOT_CANONICAL is already caught in use_note.

    user_3.set_viewing_key_e2e();

    // Catch SUBCHANNEL_NOT_FOUND - channel doesnt exist.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    user_1.open_channel_e2e(recipient: user_3, index: 2);

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

    let (random, salt, channel_output) = user_1
        .internal_open_channel_with_generated_random_and_salt(recipient: user_2, index: 0);
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
    let expected_outgoing_channel_key = user_1.compute_outgoing_channel_key(index: 0);
    let outgoing_channels_storage_path = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [expected_outgoing_channel_key].span(),
    );
    let expected_enc_outgoing_channel_info = user_1
        .compute_enc_outgoing_channel_info(recipient: user_2, index: 0, :salt);
    let expected_actions = [
        ServerAction::VerifyValue(
            VerifyValueInput { storage_address: public_key_storage_path, value: user_2.public_key },
        ),
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: channel_exists_storage_path, value: [true.into()].span(),
            },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user_2.address, enc_channel_info: expected_enc_channel_info,
            },
        ),
        expected_enc_outgoing_channel_info
            .to_write_once_action(storage_address: outgoing_channels_storage_path),
    ]
        .span();

    assert_eq!(channel_output, expected_actions);
}

#[test]
fn test_open_channel_self_channel() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();

    let (random, salt, channel_output) = user
        .internal_open_channel_with_generated_random_and_salt(recipient: user, index: 0);
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
    let expected_outgoing_channel_key = user.compute_outgoing_channel_key(index: 0);
    let outgoing_channels_storage_path = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [expected_outgoing_channel_key].span(),
    );
    let expected_enc_outgoing_channel_info = user
        .compute_enc_outgoing_channel_info(recipient: user, index: 0, :salt);
    let expected_actions = [
        ServerAction::VerifyValue(
            VerifyValueInput { storage_address: public_key_storage_path, value: user.public_key },
        ),
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: channel_exists_storage_path, value: [true.into()].span(),
            },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user.address, enc_channel_info: expected_enc_channel_info,
            },
        ),
        expected_enc_outgoing_channel_info
            .to_write_once_action(storage_address: outgoing_channels_storage_path),
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
    let random = user_1.get_random();
    let salt = user_1.get_salt().into();
    let index = 0;

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user_1;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_open_channel(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch ZERO_PRIVATE_KEY.
    let mut user_zero_private_key = user_1;
    user_zero_private_key.private_key = Zero::zero();
    let result = user_zero_private_key.safe_open_channel(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

    // Catch ZERO_RECIPIENT_ADDR.
    let mut user_zero_addr = user_2;
    user_zero_addr.address = Zero::zero();
    let result = user_1.safe_open_channel(recipient: user_zero_addr, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_RECIPIENT_PUBLIC_KEY.
    let mut user_zero_public_key = user_2;
    user_zero_public_key.public_key = Zero::zero();
    let result = user_1.safe_open_channel(recipient: user_zero_public_key, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);

    // Catch ZERO_RANDOM.
    let result = user_1.safe_open_channel(recipient: user_2, :index, random: Zero::zero(), :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_invalid_private_key = user_1;
    user_invalid_private_key.private_key = Neg::neg(user_invalid_private_key.private_key);
    let result = user_invalid_private_key
        .safe_open_channel(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch SENDER_NOT_REGISTERED.
    let result = user_1.safe_open_channel(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::SENDER_NOT_REGISTERED);

    // Catch SENDER_NOT_AUTHENTICATED.
    user_1.set_viewing_key_e2e();
    let user_1_private_key = user_1.private_key;
    user_1.private_key = user_1.public_key;
    if !is_canonical_key(key: user_1.private_key) {
        user_1.private_key = Neg::neg(user_1.private_key);
    }
    let result = user_1.safe_open_channel(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::SENDER_NOT_AUTHENTICATED);
    user_1.private_key = user_1_private_key;

    // Catch INDEX_NOT_SEQUENTIAL.
    let result = user_1.safe_open_channel(recipient: user_2, index: 1, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);
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

    let (random_1, salt_1, c1_output) = user_1
        .internal_open_channel_with_generated_random_and_salt(recipient: user_2, index: 0);
    test.privacy.execute_actions(actions: c1_output);
    let (random_2, salt_2, c2_output) = user_1
        .internal_open_channel_with_generated_random_and_salt(recipient: user_3, index: 1);
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
    let expected_outgoing_channel_key_1 = user_1.compute_outgoing_channel_key(index: 0);
    let expected_outgoing_channel_key_2 = user_1.compute_outgoing_channel_key(index: 1);
    assert_ne!(expected_outgoing_channel_key_1, expected_outgoing_channel_key_2);
    let expected_enc_outgoing_channel_info_1 = user_1
        .compute_enc_outgoing_channel_info(recipient: user_2, index: 0, salt: salt_1);
    let expected_enc_outgoing_channel_info_2 = user_1
        .compute_enc_outgoing_channel_info(recipient: user_3, index: 1, salt: salt_2);
    assert_eq!(expected_enc_outgoing_channel_info_1.salt, salt_1.into());
    assert_eq!(expected_enc_outgoing_channel_info_2.salt, salt_2.into());
    assert_ne!(
        expected_enc_outgoing_channel_info_1.enc_recipient_addr,
        expected_enc_outgoing_channel_info_2.enc_recipient_addr,
    );
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
    let outgoing_channels_storage_path_1 = map_entry_address(
        map_selector: selector!("outgoing_channels"),
        keys: [expected_outgoing_channel_key_1].span(),
    );
    let outgoing_channels_storage_path_2 = map_entry_address(
        map_selector: selector!("outgoing_channels"),
        keys: [expected_outgoing_channel_key_2].span(),
    );
    let expected_actions_1 = [
        ServerAction::VerifyValue(
            VerifyValueInput {
                storage_address: public_key_storage_path_1, value: user_2.public_key,
            },
        ),
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: channel_exists_storage_path_1, value: [true.into()].span(),
            },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user_2.address, enc_channel_info: expected_enc_channel_info_1,
            },
        ),
        expected_enc_outgoing_channel_info_1
            .to_write_once_action(storage_address: outgoing_channels_storage_path_1),
    ]
        .span();
    let expected_actions_2 = [
        ServerAction::VerifyValue(
            VerifyValueInput {
                storage_address: public_key_storage_path_2, value: user_3.public_key,
            },
        ),
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: channel_exists_storage_path_2, value: [true.into()].span(),
            },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user_3.address, enc_channel_info: expected_enc_channel_info_2,
            },
        ),
        expected_enc_outgoing_channel_info_2
            .to_write_once_action(storage_address: outgoing_channels_storage_path_2),
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

    let (random_1, salt_1, c1_output) = user_2
        .internal_open_channel_with_generated_random_and_salt(recipient: user_1, index: 0);
    let (random_2, salt_2, c2_output) = user_3
        .internal_open_channel_with_generated_random_and_salt(recipient: user_1, index: 0);
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
    let expected_outgoing_channel_key_1 = user_2.compute_outgoing_channel_key(index: 0);
    let expected_outgoing_channel_key_2 = user_3.compute_outgoing_channel_key(index: 0);
    assert_ne!(expected_outgoing_channel_key_1, expected_outgoing_channel_key_2);
    let expected_enc_outgoing_channel_info_1 = user_2
        .compute_enc_outgoing_channel_info(recipient: user_1, index: 0, salt: salt_1);
    let expected_enc_outgoing_channel_info_2 = user_3
        .compute_enc_outgoing_channel_info(recipient: user_1, index: 0, salt: salt_2);
    assert_eq!(expected_enc_outgoing_channel_info_1.salt, salt_1);
    assert_eq!(expected_enc_outgoing_channel_info_2.salt, salt_2);
    assert_ne!(
        expected_enc_outgoing_channel_info_1.enc_recipient_addr,
        expected_enc_outgoing_channel_info_2.enc_recipient_addr,
    );
    let outgoing_channels_storage_path_1 = map_entry_address(
        map_selector: selector!("outgoing_channels"),
        keys: [expected_outgoing_channel_key_1].span(),
    );
    let outgoing_channels_storage_path_2 = map_entry_address(
        map_selector: selector!("outgoing_channels"),
        keys: [expected_outgoing_channel_key_2].span(),
    );
    let expected_actions_1 = [
        ServerAction::VerifyValue(
            VerifyValueInput {
                storage_address: public_key_storage_path_1, value: user_1.public_key,
            },
        ),
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: channel_exists_storage_path_1, value: [true.into()].span(),
            },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user_1.address, enc_channel_info: expected_enc_channel_info_1,
            },
        ),
        expected_enc_outgoing_channel_info_1
            .to_write_once_action(storage_address: outgoing_channels_storage_path_1),
    ]
        .span();
    let expected_actions_2 = [
        ServerAction::VerifyValue(
            VerifyValueInput {
                storage_address: public_key_storage_path_2, value: user_1.public_key,
            },
        ),
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: channel_exists_storage_path_2, value: [true.into()].span(),
            },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user_1.address, enc_channel_info: expected_enc_channel_info_2,
            },
        ),
        expected_enc_outgoing_channel_info_2
            .to_write_once_action(storage_address: outgoing_channels_storage_path_2),
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
    user_1.open_channel_e2e(recipient: user_2, index: 0);

    // User 2 should be able to decrypt the channel info.
    assert_eq!(user_2.get_num_of_channels(), 1);
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (decrypted_channel_key, decrypted_sender_addr) = decrypt_channel_info(
        :enc_channel_info, recipient_private_key: user_2.private_key,
    );

    // Verify decrypted channel key.
    let expected_channel_key = user_1.compute_channel_key(recipient: user_2);
    assert_eq!(decrypted_channel_key, expected_channel_key);

    // Verify decrypted sender address.
    assert_eq!(decrypted_sender_addr, user_1.address);
}

#[test]
fn test_open_channel_decrypt_outgoing_channel_info() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);

    // User 2 should be able to decrypt the outgoing channel info.
    let outgoing_channel_key = user_1.compute_outgoing_channel_key(index: 0);
    let enc_outgoing_channel_info = test.privacy.get_outgoing_channel_info(:outgoing_channel_key);
    let decrypted_recipient_addr = decrypt_outgoing_channel_info(
        :enc_outgoing_channel_info,
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        index: 0,
    );
    assert_eq!(decrypted_recipient_addr, user_2.address);
}

#[test]
fn test_open_channel_zero_salt() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let index = 0;
    let random = user.get_random();
    let salt = Zero::zero();
    let actions = user.internal_open_channel(recipient: user, :index, :random, :salt);
    let expected_channel_id = user.compute_channel_id(recipient: user);
    let expected_channel_key = user.compute_channel_key(recipient: user);
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random,
        recipient_public_key: user.public_key,
        channel_key: expected_channel_key,
        sender_addr: user.address,
    );
    let expected_outgoing_channel_key = user.compute_outgoing_channel_key(index: 0);
    let expected_enc_outgoing_channel_info = user
        .compute_enc_outgoing_channel_info(recipient: user, index: 0, :salt);
    let public_key_storage_path = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let channel_exists_storage_path = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_id].span(),
    );
    let outgoing_channels_storage_path = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [expected_outgoing_channel_key].span(),
    );
    let expected_actions = [
        ServerAction::VerifyValue(
            VerifyValueInput { storage_address: public_key_storage_path, value: user.public_key },
        ),
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: channel_exists_storage_path, value: [true.into()].span(),
            },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user.address, enc_channel_info: expected_enc_channel_info,
            },
        ),
        expected_enc_outgoing_channel_info
            .to_write_once_action(storage_address: outgoing_channels_storage_path),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_open_subchannel() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, index: 0);

    let (salt, channel_output) = user_1
        .internal_open_subchannel_with_generated_salt(recipient: user_2, :token_address, index: 0);
    let expected_subchannel_key = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_enc_subchannel_info = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_address, index: 0, :salt);
    let expected_subchannel_id = user_1.compute_subchannel_id(recipient: user_2, :token_address);

    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key].span(),
    );
    let expected_actions = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: subchannel_exists_storage_path_felt, value: [true.into()].span(),
            },
        ),
        expected_enc_subchannel_info
            .to_write_once_action(storage_address: subchannel_tokens_storage_path_felt),
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
    user.open_channel_e2e(recipient: user, index: 0);

    let (salt, channel_output) = user
        .internal_open_subchannel_with_generated_salt(recipient: user, :token_address, index: 0);
    let expected_subchannel_key = user.compute_subchannel_key(recipient: user, index: 0);
    let expected_enc_subchannel_info = user
        .compute_enc_subchannel_info(recipient: user, :token_address, index: 0, :salt);
    let expected_subchannel_id = user.compute_subchannel_id(recipient: user, :token_address);

    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key].span(),
    );
    let expected_actions = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: subchannel_exists_storage_path_felt, value: [true.into()].span(),
            },
        ),
        expected_enc_subchannel_info
            .to_write_once_action(storage_address: subchannel_tokens_storage_path_felt),
    ]
        .span();
    assert_eq!(channel_output, expected_actions);
}

#[test]
fn test_open_subchannel_zero_salt() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user.open_channel_e2e(recipient: user, index: 0);

    let salt = 0;
    let index = 0;
    let actions = user.internal_open_subchannel(recipient: user, :token_address, :index, :salt);
    let expected_subchannel_key = user.compute_subchannel_key(recipient: user, index: 0);
    let expected_enc_subchannel_info = user
        .compute_enc_subchannel_info(recipient: user, :token_address, index: 0, :salt);
    let expected_subchannel_id = user.compute_subchannel_id(recipient: user, :token_address);
    assert!(expected_enc_subchannel_info.is_non_zero());
    assert!(expected_subchannel_id.is_non_zero());
    assert!(expected_subchannel_key.is_non_zero());
    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key].span(),
    );
    let expected_actions = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: subchannel_exists_storage_path_felt, value: [true.into()].span(),
            },
        ),
        expected_enc_subchannel_info
            .to_write_once_action(storage_address: subchannel_tokens_storage_path_felt),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
#[feature("safe_dispatcher")]
fn test_open_subchannel_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_address = test.mock_new_token();
    let salt = user_1.get_salt().into();
    let index = 0;

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user_1;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr
        .safe_open_subchannel(recipient: user_2, :token_address, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch ZERO_RECIPIENT_ADDR.
    let mut user_zero_addr = user_2;
    user_zero_addr.address = Zero::zero();
    let result = user_1
        .safe_open_subchannel(recipient: user_zero_addr, :token_address, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_CHANNEL_KEY.
    let result = user_1
        .safe_open_subchannel_with_channel_key(
            recipient: user_2, :token_address, :index, :salt, channel_key: Zero::zero(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_CHANNEL_KEY);

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_open_subchannel(recipient: user_2, token_address: Zero::zero(), :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_RECIPIENT_PUBLIC_KEY.
    let mut user_zero_public_key = user_2;
    user_zero_public_key.public_key = Zero::zero();
    let result = user_1
        .safe_open_subchannel(recipient: user_zero_public_key, :token_address, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);

    user_2.set_viewing_key_e2e();

    // Catch INVALID_CHANNEL - sender is not registered.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token_address, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    user_1.set_viewing_key_e2e();

    // Catch INVALID_CHANNEL - no channel exists for the given sender and recipient.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token_address, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    user_1.open_channel_e2e(recipient: user_2, index: 0);
    let channel_key = user_1.compute_channel_key(recipient: user_2);

    // Catch INVALID_CHANNEL - wrong sender_addr.
    let mut user_1_wrong_addr = user_1;
    user_1_wrong_addr.address = user_2.address;
    let result = user_1_wrong_addr
        .safe_open_subchannel(recipient: user_2, :token_address, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INVALID_CHANNEL - wrong recipient_addr.
    let mut user_2_wrong_addr = user_2;
    user_2_wrong_addr.address = user_1.address;
    let result = user_1
        .safe_open_subchannel(recipient: user_2_wrong_addr, :token_address, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INVALID_CHANNEL - wrong recipient_public_key.
    let mut user_2_wrong_public_key = user_2;
    user_2_wrong_public_key.public_key = user_1.public_key;
    let result = user_1
        .safe_open_subchannel(recipient: user_2_wrong_public_key, :token_address, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INVALID_CHANNEL - wrong channel key.
    let result = user_1
        .safe_open_subchannel_with_channel_key(
            recipient: user_2, :token_address, :index, :salt, channel_key: channel_key + 1,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INDEX_NOT_SEQUENTIAL.
    let result = user_1
        .safe_open_subchannel(recipient: user_2, :token_address, index: index + 1, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);

    // Sanity check - should succeed.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token_address, :index, :salt);
    assert_eq!(result.is_ok(), true);
}

#[test]
fn test_open_subchannel_multiple() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    let token_address_1 = test.mock_new_token();
    let token_address_2 = test.mock_new_token();

    // Multiple subchannels with different tokens.
    let (salt_1, c1_output) = user_1
        .internal_open_subchannel_with_generated_salt(
            recipient: user_2, token_address: token_address_1, index: 0,
        );
    test.privacy.execute_actions(actions: c1_output);
    let (salt_2, c2_output) = user_1
        .internal_open_subchannel_with_generated_salt(
            recipient: user_2, token_address: token_address_2, index: 1,
        );
    let expected_subchannel_key_1 = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_subchannel_key_2 = user_1.compute_subchannel_key(recipient: user_2, index: 1);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(
            recipient: user_2, token_address: token_address_1, index: 0, salt: salt_1,
        );
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(
            recipient: user_2, token_address: token_address_2, index: 1, salt: salt_2,
        );
    let expected_subchannel_id_1 = user_1
        .compute_subchannel_id(recipient: user_2, token_address: token_address_1);
    let expected_subchannel_id_2 = user_1
        .compute_subchannel_id(recipient: user_2, token_address: token_address_2);
    assert_ne!(expected_subchannel_key_1, expected_subchannel_key_2);
    assert_ne!(expected_enc_subchannel_info_1.salt, expected_enc_subchannel_info_2.salt);
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
    let expected_actions_1 = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: subchannel_exists_storage_path_felt_1, value: [true.into()].span(),
            },
        ),
        expected_enc_subchannel_info_1
            .to_write_once_action(storage_address: subchannel_tokens_storage_path_felt_1),
    ]
        .span();
    let expected_actions_2 = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: subchannel_exists_storage_path_felt_2, value: [true.into()].span(),
            },
        ),
        expected_enc_subchannel_info_2
            .to_write_once_action(storage_address: subchannel_tokens_storage_path_felt_2),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);

    // Multiple subchannels with the same token (fails only on the server side).
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    let token_address = test.mock_new_token();
    let (salt_1, c1_output) = user_1
        .internal_open_subchannel_with_generated_salt(recipient: user_2, :token_address, index: 0);
    test.privacy.execute_actions(actions: c1_output);
    let (salt_2, c2_output) = user_1
        .internal_open_subchannel_with_generated_salt(recipient: user_2, :token_address, index: 1);
    let expected_subchannel_key_1 = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_subchannel_key_2 = user_1.compute_subchannel_key(recipient: user_2, index: 1);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_address, index: 0, salt: salt_1);
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_address, index: 1, salt: salt_2);
    // Id will be the same since the token is the same.
    let expected_subchannel_id = user_1.compute_subchannel_id(recipient: user_2, :token_address);
    assert_ne!(expected_subchannel_key_1, expected_subchannel_key_2);
    assert_ne!(expected_enc_subchannel_info_1.salt, expected_enc_subchannel_info_2.salt);
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
    let expected_actions_1 = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: subchannel_exists_storage_path_felt, value: [true.into()].span(),
            },
        ),
        expected_enc_subchannel_info_1
            .to_write_once_action(storage_address: subchannel_tokens_storage_path_felt_1),
    ]
        .span();
    let expected_actions_2 = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: subchannel_exists_storage_path_felt, value: [true.into()].span(),
            },
        ),
        expected_enc_subchannel_info_2
            .to_write_once_action(storage_address: subchannel_tokens_storage_path_felt_2),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);

    // Multiple subchannels with the same index (fails only on the server side).
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    let (salt_1, c1_output) = user_1
        .internal_open_subchannel_with_generated_salt(
            recipient: user_2, token_address: token_address_1, index: 0,
        );
    test.privacy.execute_actions(actions: c1_output);
    let (salt_2, c2_output) = user_1
        .internal_open_subchannel_with_generated_salt(
            recipient: user_2, token_address: token_address_2, index: 0,
        );
    // Key will be the same since the index is the same.
    let expected_subchannel_key = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(
            recipient: user_2, token_address: token_address_1, index: 0, salt: salt_1,
        );
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(
            recipient: user_2, token_address: token_address_2, index: 0, salt: salt_2,
        );
    let expected_subchannel_id_1 = user_1
        .compute_subchannel_id(recipient: user_2, token_address: token_address_1);
    let expected_subchannel_id_2 = user_1
        .compute_subchannel_id(recipient: user_2, token_address: token_address_2);
    assert_ne!(expected_enc_subchannel_info_1.salt, expected_enc_subchannel_info_2.salt);
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
    let expected_actions_1 = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: subchannel_exists_storage_path_felt_1, value: [true.into()].span(),
            },
        ),
        expected_enc_subchannel_info_1
            .to_write_once_action(storage_address: subchannel_tokens_storage_path_felt),
    ]
        .span();
    let expected_actions_2 = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: subchannel_exists_storage_path_felt_2, value: [true.into()].span(),
            },
        ),
        expected_enc_subchannel_info_2
            .to_write_once_action(storage_address: subchannel_tokens_storage_path_felt),
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
    user.open_channel_e2e(recipient: user, index: 0);

    // Multiple subchannels with different tokens.
    let (salt_1, c1_output) = user
        .internal_open_subchannel_with_generated_salt(
            recipient: user, token_address: token_address_1, index: 0,
        );
    test.privacy.execute_actions(actions: c1_output);
    let (salt_2, c2_output) = user
        .internal_open_subchannel_with_generated_salt(
            recipient: user, token_address: token_address_2, index: 1,
        );
    let expected_subchannel_key_1 = user.compute_subchannel_key(recipient: user, index: 0);
    let expected_subchannel_key_2 = user.compute_subchannel_key(recipient: user, index: 1);
    let expected_enc_subchannel_info_1 = user
        .compute_enc_subchannel_info(
            recipient: user, token_address: token_address_1, index: 0, salt: salt_1,
        );
    let expected_enc_subchannel_info_2 = user
        .compute_enc_subchannel_info(
            recipient: user, token_address: token_address_2, index: 1, salt: salt_2,
        );
    let expected_subchannel_id_1 = user
        .compute_subchannel_id(recipient: user, token_address: token_address_1);
    let expected_subchannel_id_2 = user
        .compute_subchannel_id(recipient: user, token_address: token_address_2);
    assert_ne!(expected_subchannel_key_1, expected_subchannel_key_2);
    assert_ne!(expected_enc_subchannel_info_1.salt, expected_enc_subchannel_info_2.salt);
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
    let expected_actions_1 = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: subchannel_exists_storage_path_felt_1, value: [true.into()].span(),
            },
        ),
        expected_enc_subchannel_info_1
            .to_write_once_action(storage_address: subchannel_tokens_storage_path_felt_1),
    ]
        .span();
    let expected_actions_2 = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: subchannel_exists_storage_path_felt_2, value: [true.into()].span(),
            },
        ),
        expected_enc_subchannel_info_2
            .to_write_once_action(storage_address: subchannel_tokens_storage_path_felt_2),
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
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    user_1.open_subchannel_e2e(recipient: user_2, :token_address, index: 0);

    // User 2 should be able to decrypt the subchannel info (the token).
    // User 2 decrypts the channel_key.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (decrypted_channel_key, _) = decrypt_channel_info(
        :enc_channel_info, recipient_private_key: user_2.private_key,
    );
    // User 2 decrypts the subchannel token.
    let subchannel_key = compute_subchannel_key(channel_key: decrypted_channel_key, index: 0);
    let enc_subchannel_info = test.privacy.get_subchannel_info(:subchannel_key);
    let decrypted_token = decrypt_subchannel_token(
        :enc_subchannel_info, channel_key: decrypted_channel_key, index: 0,
    );
    assert_eq!(decrypted_token, token_address);
}

#[test]
fn test_create_note_self_note() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user
        .open_channel_with_token_e2e(
            recipient: user, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount = 1;
    let note_index = 0;
    let note = user
        .new_note_with_generated_salt(recipient: user, :token_address, :amount, index: note_index);
    let actions = user.internal_create_note(:note);
    assert_eq!(actions, user.note_to_server_actions(:note));
}

#[test]
fn test_create_note_twice() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount_1 = 1;
    let note_index_1 = 0;
    let note_1 = user_1
        .new_note_with_generated_salt(
            recipient: user_2, :token_address, amount: amount_1, index: note_index_1,
        );
    let create_note_1_actions = user_1.internal_create_note(note: note_1);
    let amount_2 = amount_1 + 1;
    let note_index_2 = note_index_1 + 1;
    user_1.privacy.execute_actions(actions: create_note_1_actions);
    let note_2 = user_1
        .new_note_with_generated_salt(
            recipient: user_2, :token_address, amount: amount_2, index: note_index_2,
        );
    let create_note_2_actions = user_1.internal_create_note(note: note_2);
    let (note_id_1, expected_note_1) = user_1.compute_note(note: note_1);
    let (note_id_2, expected_note_2) = user_1.compute_note(note: note_2);
    assert_ne!(note_id_1, note_id_2);
    assert_ne!(expected_note_1.enc_value, expected_note_2.enc_value);
    assert_eq!(create_note_1_actions, user_1.note_to_server_actions(note: note_1));
    assert_eq!(create_note_2_actions, user_1.note_to_server_actions(note: note_2));
}

#[test]
fn test_create_note_twice_same_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount = 1;
    let note_index_1 = 0;
    let note_1 = user_1
        .new_note_with_generated_salt(
            recipient: user_2, :token_address, :amount, index: note_index_1,
        );
    let create_note_1_actions = user_1.internal_create_note(note: note_1);
    let note_index_2 = note_index_1 + 1;
    test.privacy.execute_actions(actions: create_note_1_actions);
    let note_2 = user_1
        .new_note_with_generated_salt(
            recipient: user_2, :token_address, :amount, index: note_index_2,
        );
    let create_note_2_actions = user_1.internal_create_note(note: note_2);
    let (note_id_1, expected_note_1) = user_1.compute_note(note: note_1);
    let (note_id_2, expected_note_2) = user_1.compute_note(note: note_2);
    assert_ne!(note_id_1, note_id_2);
    assert_ne!(expected_note_1.enc_value, expected_note_2.enc_value);
    assert_eq!(create_note_1_actions, user_1.note_to_server_actions(note: note_1));
    assert_eq!(create_note_2_actions, user_1.note_to_server_actions(note: note_2));
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
        .new_note_with_generated_salt(recipient: user_2, :token_address, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'ZERO_TOKEN')]
fn test_create_note_zero_token() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let user_2 = test.new_user();
    let note = user_1
        .new_note_with_generated_salt(
            recipient: user_2, token_address: Zero::zero(), amount: 1, index: 0,
        );
    user_1.create_note(:note);
}

#[test]
fn test_create_note_use_note_zero_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_address = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    user_2
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    // Create note with zero amount.
    let note = user_1
        .new_note_with_generated_salt(recipient: user_2, :token_address, amount: 0, index: 0);
    let server_actions = user_1.create_note(:note);
    let (note_id, expected_note) = user_1.compute_note(:note);
    assert_ne!(note_id, Zero::zero());
    assert_ne!(expected_note.enc_value, Zero::zero());
    assert_eq!(server_actions, user_1.note_to_server_actions(:note));
    assert_eq!(user_1.privacy.get_note(:note_id), Zero::zero());
    user_1.privacy.execute_actions(actions: server_actions);
    assert_eq!(user_1.privacy.get_note(:note_id), expected_note.enc_value);
    // Use note with zero amount.
    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key,
        channel_key: user_1.compute_channel_key(recipient: user_2),
        token: token_address,
        note_index: 0,
    };
    let create_note_input = user_2
        .new_note_with_generated_salt(recipient: user_2, :token_address, amount: 0, index: 0);
    let client_actions = [
        ClientAction::UseNote(use_note_input), ClientAction::CreateNote(create_note_input),
    ]
        .span();
    let server_actions = user_2.client_execute(:client_actions);
    let expected_nullifier = user_2
        .compute_nullifier(sender: user_1, :token_address, note_index: 0);
    assert_ne!(expected_nullifier, Zero::zero());
    let nullifier_storage_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let (note_id, expected_note) = user_2.compute_note(note: create_note_input);
    assert_ne!(note_id, Zero::zero());
    assert_ne!(expected_note.enc_value, Zero::zero());
    let expected_server_actions = [
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: nullifier_storage_path, value: [true.into()].span() },
        ),
        user_2.note_to_server_action(note: create_note_input),
    ]
        .span();
    assert_eq!(server_actions, expected_server_actions);
    assert!(!user_2.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(user_2.privacy.get_note(:note_id), Zero::zero());
    user_2.privacy.execute_actions(actions: server_actions);
    assert!(user_2.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(user_2.privacy.get_note(:note_id), expected_note.enc_value);
}

#[test]
#[should_panic(expected: 'SALT_TOO_SMALL')]
fn test_create_note_zero_salt() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_address = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let note = user_1
        .new_note(recipient: user_2, :token_address, amount: 1, index: 0, salt: Zero::zero());
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'SALT_TOO_SMALL')]
fn test_create_note_salt_too_small() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_address = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let note = user_1.new_note(recipient: user_2, :token_address, amount: 1, index: 0, salt: 1);
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
        .new_note_with_generated_salt(recipient: user_2, :token_address, amount: 1, index: 0);
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
        .new_note_with_generated_salt(recipient: user_2, :token_address, amount: 1, index: 0);
    user_1.create_note(:note);
}

#[test]
#[should_panic(expected: 'SALT_EXCEEDS_120_BITS')]
fn test_create_note_salt_exceeds_120_bits() {
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
            salt: TWO_POW_120.try_into().unwrap(),
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
        .new_note_with_generated_salt(recipient: user_2, :token_address, amount: 1, index: 0);
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
        .new_note_with_generated_salt(recipient: user_2, :token_address, amount: 1, index: 0);
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
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    let note = user_1
        .new_note_with_generated_salt(recipient: user_2, :token_address, amount: 1, index: 0);
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let note = user_1
        .new_note_with_generated_salt(recipient: user_2, :token_address, amount: 1, index: 0);
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    user_1.new_key();
    let note = user_1
        .new_note_with_generated_salt(recipient: user_2, :token_address, amount: 1, index: 0);
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    user_2.public_key = user_1.public_key;
    let note = user_1
        .new_note_with_generated_salt(recipient: user_2, :token_address, amount: 1, index: 0);
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let mut note = user_1
        .new_note_with_generated_salt(recipient: user_2, :token_address, amount: 1, index: 0);
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount = 1;
    let note = user_1
        .new_note_with_generated_salt(recipient: user_2, :token_address, :amount, index: 1);
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_salt(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    let create_note_actions = user_1.internal_create_note(:note);
    user_1.privacy.execute_actions(actions: create_note_actions);

    // User 2 should be able to decrypt the amount.
    // Decrypt channel key.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (channel_key, _) = decrypt_channel_info(
        :enc_channel_info, recipient_private_key: user_2.private_key,
    );
    let note_id = compute_note_id(:channel_key, token: token_address, index: note_index);
    let enc_amount = user_2.privacy.get_note(:note_id);
    let decrypted_amount = decrypt_note_amount(
        enc_note_value: enc_amount, :channel_key, token: token_address, index: note_index,
    );
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_salt(
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
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: nullifier_storage_path, value: [true.into()].span() },
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
    user
        .open_channel_with_token_e2e(
            recipient: user, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount = 1;
    let note_index = 0;
    let note = user
        .new_note_with_generated_salt(recipient: user, :token_address, :amount, index: note_index);
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
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: nullifier_storage_path, value: [true.into()].span() },
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
    user_2
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount_1 = 1;
    let amount_2 = 2;
    let note_1 = user_1
        .new_note_with_generated_salt(
            recipient: user_2, :token_address, amount: amount_1, index: 0,
        );
    let note_2 = user_1
        .new_note_with_generated_salt(
            recipient: user_2, :token_address, amount: amount_2, index: 1,
        );
    let note_3 = user_2
        .new_note_with_generated_salt(
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
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: nullifier_storage_path_1, value: [true.into()].span(),
            },
        )
    ]
        .span();
    let expected_actions_2 = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: nullifier_storage_path_2, value: [true.into()].span(),
            },
        )
    ]
        .span();
    let expected_actions_3 = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: nullifier_storage_path_3, value: [true.into()].span(),
            },
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_salt(
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
    user_2.client_execute(:client_actions);
}

#[test]
fn test_use_note_same_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_address = test.mock_new_token();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount = 1;
    let note_1 = user_1
        .new_note_with_generated_salt(recipient: user_2, :token_address, :amount, index: 0);
    let note_2 = user_1
        .new_note_with_generated_salt(recipient: user_2, :token_address, :amount, index: 1);
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
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: nullifier_storage_path_1, value: [true.into()].span(),
            },
        )
    ]
        .span();
    let expected_actions_2 = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: nullifier_storage_path_2, value: [true.into()].span(),
            },
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    user_2.open_channel_e2e(recipient: user_1, index: 0);
    let note = user_1
        .new_note_with_generated_salt(recipient: user_2, :token_address, amount: 1, index: 0);
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_salt(
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_salt(
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
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    user_2.open_channel_e2e(recipient: user_2, index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_salt(
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
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_salt(
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let amount = 1;
    let note_index = 0;
    let note = user_1
        .new_note_with_generated_salt(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    user_1.cheat_create_note_e2e(:note);

    // User 2 should be able to find the nullifier.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (channel_key, _) = decrypt_channel_info(
        :enc_channel_info, recipient_private_key: user_2.private_key,
    );
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
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: nullifier_storage_path, value: [true.into()].span() },
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
    user_1
        .open_channel_with_token_e2e(
            recipient: user_1, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );

    // Withdraw note to self.
    let (random, actions) = user_1
        .internal_withdraw_with_generated_random(
            withdrawal_target: user_1.address, :token_address, :amount,
        );
    let enc_user_addr = user_1.compute_enc_user_addr(:random);
    let expected_actions = [
        ServerAction::TransferTo(
            TransferToInput { recipient_addr: user_1.address, token: token_address, amount },
        ),
        ServerAction::EmitWithdrawal(
            events::Withdrawal {
                enc_user_addr, withdrawal_target: user_1.address, token: token_address, amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Withdraw note to other registered user.
    let (random, actions) = user_1
        .internal_withdraw_with_generated_random(
            withdrawal_target: user_2.address, :token_address, :amount,
        );
    let enc_user_addr = user_1.compute_enc_user_addr(:random);
    let expected_actions = [
        ServerAction::TransferTo(
            TransferToInput { recipient_addr: user_2.address, token: token_address, amount },
        ),
        ServerAction::EmitWithdrawal(
            events::Withdrawal {
                enc_user_addr, withdrawal_target: user_2.address, token: token_address, amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Withdraw note to not registered user.
    let (random, actions) = user_1
        .internal_withdraw_with_generated_random(
            withdrawal_target: user_3.address, :token_address, :amount,
        );
    let enc_user_addr = user_1.compute_enc_user_addr(:random);
    let expected_actions = [
        ServerAction::TransferTo(
            TransferToInput { recipient_addr: user_3.address, token: token_address, amount },
        ),
        ServerAction::EmitWithdrawal(
            events::Withdrawal {
                enc_user_addr, withdrawal_target: user_3.address, token: token_address, amount,
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
    let random = user_1.get_random().into();

    // Catch ZERO_WITHDRAWAL_TARGET.
    let result = user_1
        .safe_withdraw(withdrawal_target: Zero::zero(), :token_address, :amount, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_WITHDRAWAL_TARGET);

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_withdraw(
            withdrawal_target: user_2.address, token_address: Zero::zero(), :amount, :random,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT.
    let result = user_1
        .safe_withdraw(
            withdrawal_target: user_2.address, :token_address, amount: Zero::zero(), :random,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);

    // Catch ZERO_RANDOM.
    let result = user_1
        .safe_withdraw(
            withdrawal_target: user_2.address, :token_address, :amount, random: Zero::zero(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);
}

#[test]
fn test_withdraw_decrypt_user_addr() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    // Setup.
    user_1.set_viewing_key_e2e();
    let token = test.new_token();
    let token_address = token.contract_address();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_1, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    // Initialize: deposit + create note.
    let amount = 100;
    user_1.deposit_and_create_note_e2e(:token, :amount);
    // Use note + withdraw.
    let channel_key = user_1.compute_channel_key(recipient: user_1);
    let mut spy_events = spy_events();
    user_1
        .withdraw_and_use_note_e2e(
            withdrawal_target: user_1.address, :token, :amount, :channel_key, note_index: 0,
        );

    // Compliance should be able to decrypt the user address.
    let events = spy_events.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    let (_, event) = events[0];
    let enc_user_addr = EncUserAddr {
        compliance_public_key: *event.data[0],
        ephemeral_pubkey: *event.data[1],
        enc_user_addr: *event.data[2],
    };
    let decrypted_user_addr = decrypt_enc_user_addr(
        :enc_user_addr, compliance_private_key: test.compliance_private_key,
    );
    assert_eq!(decrypted_user_addr, user_1.address);
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
fn test_client_execute_set_viewing_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();

    let random = user_1.get_random();
    let client_actions = [
        ClientAction::SetViewingKey(SetViewingKeyInput { private_key: user_1.private_key, random })
    ]
        .span();
    let actions = user_1.client_execute(:client_actions);
    let enc_private_key = user_1.compute_enc_private_key(:random);
    let public_key_storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user_1.address.into()].span(),
    );
    let enc_private_key_storage_path_felt = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [user_1.address.into()].span(),
    );
    let expected_event = events::ViewingKeySet {
        user_addr: user_1.address, public_key: user_1.public_key, enc_private_key,
    };
    let expected_actions = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: public_key_storage_path_felt, value: [user_1.public_key].span(),
            },
        ),
        enc_private_key.to_write_once_action(storage_address: enc_private_key_storage_path_felt),
        ServerAction::EmitViewingKeySet(expected_event),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    let view_actions = user_1.execute_view(:client_actions);
    assert_eq!(view_actions, actions);
    assert_eq!(user_1.get_public_key(), Zero::zero());
    assert_eq!(user_1.get_enc_private_key().ephemeral_pubkey, Zero::zero());
    assert_eq!(user_1.get_enc_private_key().enc_private_key, Zero::zero());
    // TODO: Verify no events emitted (after snforge revert bug is resolved).

    let mut spy_events = spy_events();
    test.privacy.execute_actions(:actions);
    assert_eq!(user_1.get_public_key(), user_1.public_key);
    assert_eq!(user_1.get_enc_private_key(), enc_private_key);
    let events = spy_events.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        :expected_event,
        expected_event_selector: @selector!("ViewingKeySet"),
        expected_event_name: "ViewingKeySet",
    );
}

#[test]
fn test_client_execute_open_channel() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();

    // Open channel action.
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let random = user_1.get_random();
    let salt = user_1.get_salt().into();
    let client_actions = [
        ClientAction::OpenChannel(
            OpenChannelInput {
                sender_private_key: user_1.private_key,
                recipient_addr: user_2.address,
                recipient_public_key: user_2.public_key,
                index: 0,
                random,
                salt,
            },
        )
    ]
        .span();
    let actions = user_1.client_execute(:client_actions);
    let expected_channel_id = user_1.compute_channel_id(recipient: user_2);
    let expected_channel_key = user_1.compute_channel_key(recipient: user_2);
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random,
        recipient_public_key: user_2.public_key,
        channel_key: expected_channel_key,
        sender_addr: user_1.address,
    );
    let expected_outgoing_channel_key = user_1.compute_outgoing_channel_key(index: 0);
    let expected_enc_outgoing_channel_info = user_1
        .compute_enc_outgoing_channel_info(recipient: user_2, index: 0, :salt);
    let recipient_public_key_storage_path = map_entry_address(
        map_selector: selector!("public_key"), keys: [user_2.address.into()].span(),
    );
    let channel_exists_storage_path = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_id].span(),
    );
    let outgoing_channels_storage_path = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [expected_outgoing_channel_key].span(),
    );
    let expected_actions = [
        ServerAction::VerifyValue(
            VerifyValueInput {
                storage_address: recipient_public_key_storage_path, value: user_2.public_key,
            },
        ),
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: channel_exists_storage_path, value: [true.into()].span(),
            },
        ),
        ServerAction::AppendToVec(
            AppendToVecInput {
                recipient_addr: user_2.address, enc_channel_info: expected_enc_channel_info,
            },
        ),
        expected_enc_outgoing_channel_info
            .to_write_once_action(storage_address: outgoing_channels_storage_path),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    let view_actions = user_1.execute_view(:client_actions);
    assert_eq!(view_actions, actions);
    assert!(!test.privacy.channel_exists(channel_id: expected_channel_id));
    assert_eq!(user_2.get_num_of_channels(), 0);
    let result = user_2.safe_get_channel_info(channel_index: 0);
    assert_panic_with_error(:result, expected_error: "Index out of bounds");
    assert_eq!(user_1.get_num_of_channels(), 0);

    test.privacy.execute_actions(:actions);
    assert!(test.privacy.channel_exists(channel_id: expected_channel_id));
    assert_eq!(user_2.get_num_of_channels(), 1);
    assert_eq!(user_2.get_channel_info(channel_index: 0), expected_enc_channel_info);
    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(
        test.privacy.get_outgoing_channel_info(outgoing_channel_key: expected_outgoing_channel_key),
        expected_enc_outgoing_channel_info,
    );
}

#[test]
fn test_client_execute_open_subchannel() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_address = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);

    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let salt = user_1.get_salt().into();
    let client_actions = [
        ClientAction::OpenSubchannel(
            OpenSubchannelInput {
                recipient_addr: user_2.address,
                recipient_public_key: user_2.public_key,
                channel_key,
                index: 0,
                token: token_address,
                salt,
            },
        ),
    ]
        .span();
    let actions = user_1.client_execute(:client_actions);
    let expected_subchannel_id = user_1.compute_subchannel_id(recipient: user_2, :token_address);
    let expected_subchannel_key = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    let expected_enc_subchannel_info = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_address, index: 0, :salt);
    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_id].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_key].span(),
    );
    let expected_actions = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: subchannel_exists_storage_path_felt, value: [true.into()].span(),
            },
        ),
        expected_enc_subchannel_info
            .to_write_once_action(storage_address: subchannel_tokens_storage_path_felt),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    let view_actions = user_1.execute_view(:client_actions);
    assert_eq!(view_actions, actions);
    assert!(!test.privacy.subchannel_exists(subchannel_id: expected_subchannel_id));
    assert_eq!(
        test.privacy.get_subchannel_info(subchannel_key: expected_subchannel_key), Zero::zero(),
    );

    test.privacy.execute_actions(:actions);
    assert!(test.privacy.subchannel_exists(subchannel_id: expected_subchannel_id));
    assert_eq!(
        test.privacy.get_subchannel_info(subchannel_key: expected_subchannel_key),
        expected_enc_subchannel_info,
    );
}

#[test]
fn test_client_execute_deposit_create_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_address = token.contract_address();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);

    let amount = 100;
    let note = user_1
        .new_note_with_generated_salt(recipient: user_2, :token_address, :amount, index: 0);
    user_1.open_subchannel_e2e(recipient: user_2, :token_address, index: 0);
    user_1.increase_token_balance(:token, :amount);
    user_1.approve(:token, amount: amount.into());
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_address, amount }),
        ClientAction::CreateNote(note),
    ]
        .span();
    let actions = user_1.client_execute(:client_actions);
    let (note_id, expected_note) = user_1.compute_note(:note);
    let expected_event = events::Deposit {
        user_addr: user_1.address, token: token_address, amount,
    };
    let expected_actions = array![
        ServerAction::TransferFrom(
            TransferFromInput {
                sender_addr: user_1.address, token: token_address, amount: amount.into(),
            },
        ),
        ServerAction::EmitDeposit(expected_event), user_1.note_to_server_action(:note),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    let view_actions = user_1.execute_view(:client_actions);
    assert_eq!(view_actions, actions);
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());
    assert_eq!(token.balance_of(address: user_1.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    test.privacy.execute_actions(:actions);
    assert_eq!(test.privacy.get_note(:note_id), expected_note.enc_value);
    assert_eq!(token.balance_of(address: user_1.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
}

#[test]
fn test_client_execute_use_note_create_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_address = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    user_1.open_subchannel_e2e(recipient: user_2, :token_address, index: 0);

    let amount = 100;
    let note = user_1
        .new_note_with_generated_salt(recipient: user_2, :token_address, :amount, index: 0);
    user_1.cheat_create_note_e2e(:note);
    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key,
        channel_key: user_1.compute_channel_key(recipient: user_2),
        token: token_address,
        note_index: note.index,
    };
    let create_note_input = user_2
        .new_note_with_generated_salt(recipient: user_1, :token_address, :amount, index: 0);
    user_2.open_channel_e2e(recipient: user_1, index: 0);
    user_2.open_subchannel_e2e(recipient: user_1, :token_address, index: 0);
    let client_actions = [
        ClientAction::UseNote(use_note_input), ClientAction::CreateNote(create_note_input),
    ]
        .span();
    let actions = user_2.client_execute(:client_actions);
    let (note_id, expected_note) = user_2.compute_note(note: create_note_input);
    let nullifier = user_2
        .compute_nullifier(sender: user_1, :token_address, note_index: note.index);
    let nullifier_storage_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let expected_actions = array![
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: nullifier_storage_path, value: [true.into()].span() },
        ),
        user_2.note_to_server_action(note: create_note_input),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    let view_actions = user_2.execute_view(:client_actions);
    assert_eq!(view_actions, actions);
    assert!(!test.privacy.nullifier_exists(:nullifier));
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    test.privacy.execute_actions(:actions);
    assert!(test.privacy.nullifier_exists(:nullifier));
    assert_eq!(test.privacy.get_note(:note_id), expected_note.enc_value);
}

#[test]
fn test_client_execute_use_note_withdraw() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_address = token.contract_address();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    user_1.open_subchannel_e2e(recipient: user_2, :token_address, index: 0);
    let amount = 100;
    let note = user_1
        .new_note_with_generated_salt(recipient: user_2, :token_address, :amount, index: 0);
    user_1.cheat_create_note_e2e(:note);
    test.privacy.increase_token_balance(:token, :amount);

    let use_note_input = UseNoteInput {
        owner_private_key: user_2.private_key,
        channel_key: user_1.compute_channel_key(recipient: user_2),
        token: token_address,
        note_index: note.index,
    };
    let random = user_2.get_random().into();
    let client_actions = [
        ClientAction::UseNote(use_note_input),
        ClientAction::Withdraw(
            WithdrawInput {
                withdrawal_target: user_1.address, token: token_address, amount, random,
            },
        ),
    ]
        .span();
    let actions = user_2.client_execute(:client_actions);
    let nullifier = user_2
        .compute_nullifier(sender: user_1, :token_address, note_index: note.index);
    let nullifier_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let enc_user_addr = user_2.compute_enc_user_addr(:random);
    let expected_event = events::Withdrawal {
        enc_user_addr, withdrawal_target: user_1.address, token: token_address, amount,
    };
    let expected_actions = array![
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: nullifier_path, value: [true.into()].span() },
        ),
        ServerAction::TransferTo(
            TransferToInput { recipient_addr: user_1.address, token: token_address, amount },
        ),
        ServerAction::EmitWithdrawal(expected_event),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    let view_actions = user_2.execute_view(:client_actions);
    assert_eq!(view_actions, actions);
    assert!(!test.privacy.nullifier_exists(:nullifier));
    assert_eq!(token.balance_of(address: user_1.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    test.privacy.execute_actions(:actions);
    assert!(test.privacy.nullifier_exists(:nullifier));
    assert_eq!(token.balance_of(address: user_1.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
}

#[test]
fn test_internal_actions() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_address = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);

    // TODO: Add missing actions here.

    // Create note action.
    let amount = 1;
    let note_index = 0;
    let subchannel_index = 0;
    let note = user_1
        .new_note_with_generated_salt(
            recipient: user_2, :token_address, :amount, index: note_index,
        );
    user_1.open_subchannel_e2e(recipient: user_2, :token_address, index: subchannel_index);
    let actions = user_1.internal_create_note(:note);
    assert_eq!(actions, user_1.note_to_server_actions(:note));

    // TODO: Test writing only `enc_value` to storage when open notes are implemented.

    // Deposit action.
    let actions = user_1.internal_deposit(:token_address, :amount);
    let expected_event = events::Deposit {
        user_addr: user_1.address, token: token_address, amount,
    };
    let expected_actions = [
        ServerAction::TransferFrom(
            TransferFromInput { sender_addr: user_1.address, token: token_address, amount: amount },
        ),
        ServerAction::EmitDeposit(expected_event),
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
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: storage_path_felt_nullifier, value: [true.into()].span(),
            },
        )
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Withdraw action.
    let (random, actions) = user_2
        .internal_withdraw_with_generated_random(
            withdrawal_target: user_1.address, :token_address, :amount,
        );
    let enc_user_addr = user_2.compute_enc_user_addr(:random);
    let expected_event = events::Withdrawal {
        enc_user_addr, withdrawal_target: user_1.address, token: token_address, amount,
    };
    let expected_actions = [
        ServerAction::TransferTo(
            TransferToInput {
                recipient_addr: user_1.address, token: token_address, amount: amount,
            },
        ),
        ServerAction::EmitWithdrawal(expected_event),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

// TODO: Fix this test. Now failing because storage writings are not reverted when panicking.
#[test]
#[ignore]
fn test_client_execute_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token_address = test.mock_new_token();
    let amount = 100;
    user.set_viewing_key_e2e();
    let note_1 = user
        .new_note_with_generated_salt(recipient: user, :token_address, :amount, index: 0);
    let note_1_path = UseNoteInput {
        owner_private_key: user.private_key,
        channel_key: user.compute_channel_key(recipient: user),
        token: token_address,
        note_index: 0,
    };
    let note_2 = CreateNoteInput { index: 1, ..note_1 };

    // Catch INVALID_SIGNATURE.
    let mut user_invalid = test.new_user_with_is_valid(is_valid: false);
    let result = user_invalid
        .safe_client_execute(
            client_actions: [
                ClientAction::SetViewingKey(
                    SetViewingKeyInput {
                        private_key: user_invalid.private_key, random: user_invalid.get_random(),
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SIGNATURE);

    // TODO: Catch server errors.

    // Catch NON_ZERO_CALLER.
    let result = user.safe_client_execute_without_cheat(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_CALLER);

    // Catch INVALID_TX_VERSION.
    user.privacy.cheat_zero_caller_address();
    cheat_transaction_version(
        contract_address: user.privacy.address,
        version: Zero::zero(),
        span: CheatSpan::TargetCalls(1),
    );
    let result = user.safe_client_execute_without_cheat(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_TX_VERSION);

    // Catch NOV_ZERO_TIP.
    user.privacy.cheat_zero_caller_address();
    cheat_tip(contract_address: user.privacy.address, tip: 1, span: CheatSpan::TargetCalls(1));
    let result = user.safe_client_execute_without_cheat(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_TIP);

    // Catch NON_ZERO_RESOURCE_PRICE.
    user.privacy.cheat_zero_caller_address();
    let result = user.safe_client_execute_without_cheat(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_RESOURCE_PRICE);

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_client_execute(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch ACTIONS_OUT_OF_ORDER (set viewing key twice).
    let random = user.get_random();
    let result = user
        .safe_client_execute(
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
    let salt = user.get_salt().into();
    let result = user
        .safe_client_execute(
            client_actions: [
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        sender_private_key: user.private_key,
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        index: 0,
                        random,
                        salt,
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
    user.open_channel_e2e(recipient: user, index: 0);
    let channel_key = user.compute_channel_key(recipient: user);
    let salt = user.get_salt().into();
    let result = user
        .safe_client_execute(
            client_actions: [
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key,
                        index: 0,
                        token: token_address,
                        salt,
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
        .safe_client_execute(
            client_actions: [
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key,
                        index: 0,
                        token: token_address,
                        salt,
                    },
                ),
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        sender_private_key: user.private_key,
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        index: 0,
                        random,
                        salt,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (deposit -> set viewing key).
    let result = user
        .safe_client_execute(
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
        .safe_client_execute(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        sender_private_key: user.private_key,
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        index: 0,
                        random,
                        salt,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (deposit -> open subchannel).
    let result = user
        .safe_client_execute(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key,
                        index: 0,
                        token: token_address,
                        salt,
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
        .safe_client_execute(
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
        .safe_client_execute(
            client_actions: [
                ClientAction::UseNote(note_1_path),
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        sender_private_key: user.private_key,
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        index: 0,
                        random,
                        salt,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (use note -> open subchannel).
    let result = user
        .safe_client_execute(
            client_actions: [
                ClientAction::UseNote(note_1_path),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key,
                        index: 0,
                        token: token_address,
                        salt,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (use note -> deposit).
    let result = user
        .safe_client_execute(
            client_actions: [
                ClientAction::UseNote(note_1_path),
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create note -> set viewing key).
    let result = user
        .safe_client_execute(
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
        .safe_client_execute(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::CreateNote(note_2),
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        sender_private_key: user.private_key,
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        index: 0,
                        random,
                        salt,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create note -> open subchannel).
    let result = user
        .safe_client_execute(
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
                        salt,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create note -> deposit).
    let result = user
        .safe_client_execute(
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
        .safe_client_execute(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::CreateNote(note_2), ClientAction::UseNote(note_1_path),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> set viewing key).
    let result = user
        .safe_client_execute(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput {
                        withdrawal_target: user.address, token: token_address, amount, random,
                    },
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
        .safe_client_execute(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput {
                        withdrawal_target: user.address, token: token_address, amount, random,
                    },
                ),
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        sender_private_key: user.private_key,
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        index: 0,
                        random,
                        salt,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> open subchannel).
    let result = user
        .safe_client_execute(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput {
                        withdrawal_target: user.address, token: token_address, amount, random,
                    },
                ),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key,
                        index: 0,
                        token: token_address,
                        salt,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> deposit).
    let result = user
        .safe_client_execute(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput {
                        withdrawal_target: user.address, token: token_address, amount, random,
                    },
                ),
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> use note).
    let result = user
        .safe_client_execute(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput {
                        withdrawal_target: user.address, token: token_address, amount, random,
                    },
                ),
                ClientAction::UseNote(note_1_path),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> create note).
    let result = user
        .safe_client_execute(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput {
                        withdrawal_target: user.address, token: token_address, amount, random,
                    },
                ),
                ClientAction::CreateNote(note_2),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch FINAL_BALANCE_MUST_BE_ZERO (deposit).
    let result = user
        .safe_client_execute(
            client_actions: [ClientAction::Deposit(DepositInput { token: token_address, amount }),]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::FINAL_BALANCE_MUST_BE_ZERO);

    // Catch FINAL_BALANCE_MUST_BE_ZERO (use note).
    let result = user
        .safe_client_execute(client_actions: [ClientAction::UseNote(note_1_path),].span());
    assert_panic_with_felt_error(:result, expected_error: errors::FINAL_BALANCE_MUST_BE_ZERO);

    // Catch NEGATIVE_INTERMEDIATE_BALANCE (withdraw).
    let result = user
        .safe_client_execute(
            client_actions: [
                ClientAction::Withdraw(
                    WithdrawInput {
                        withdrawal_target: user.address, token: token_address, amount, random,
                    },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);

    // Catch NEGATIVE_INTERMEDIATE_BALANCE (create note).
    let result = user
        .safe_client_execute(client_actions: [ClientAction::CreateNote(note_2),].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);

    // Catch NEGATIVE_INTERMEDIATE_BALANCE (wrong order)
    let result = user
        .safe_client_execute(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::Withdraw(
                    WithdrawInput {
                        withdrawal_target: user.address,
                        token: token_address,
                        amount: 2 * amount,
                        random,
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
fn test_client_execute_writes() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let token_address = token.contract_address();
    let amount = 100;
    let private_key = user.private_key;
    let random = user.get_random();
    let salt = user.get_salt();
    let recipient_addr = user.address;
    let recipient_public_key = user.public_key;
    let channel_key = user.compute_channel_key(recipient: user);
    let index = 0;

    // Test SetViewingKey, OpenChannel, OpenSubchannel writes.
    let set_viewing_key = ClientAction::SetViewingKey(
        SetViewingKeyInput { private_key, random: random.into() },
    );
    let open_channel = ClientAction::OpenChannel(
        OpenChannelInput {
            sender_private_key: private_key,
            recipient_addr,
            recipient_public_key,
            index,
            random: random.into(),
            salt: salt.into(),
        },
    );
    let open_subchannel = ClientAction::OpenSubchannel(
        OpenSubchannelInput {
            recipient_addr,
            recipient_public_key,
            channel_key,
            index,
            token: token_address,
            salt: salt.into(),
        },
    );
    let deposit = ClientAction::Deposit(DepositInput { token: token_address, amount });
    let create_note_input = CreateNoteInput {
        sender_private_key: private_key,
        recipient_addr,
        recipient_public_key,
        token: token_address,
        amount,
        index,
        salt,
    };
    let create_note = ClientAction::CreateNote(create_note_input);
    let client_actions = [set_viewing_key, open_channel, open_subchannel, deposit, create_note]
        .span();
    // Compile client actions.
    let mut spy_events = spy_events();
    let server_actions = user.client_execute(:client_actions);
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
    let outgoing_channel_key = user.compute_outgoing_channel_key(index: 0);
    let outgoing_channels_storage_path = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [outgoing_channel_key].span(),
    );
    let enc_outgoing_channel_info = user
        .compute_enc_outgoing_channel_info(recipient: user, :index, salt: salt.into());
    let subchannel_id = user.compute_subchannel_id(recipient: user, :token_address);
    let subchannel_exists_storage_path = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [subchannel_id].span(),
    );
    let subchannel_key = user.compute_subchannel_key(recipient: user, :index);
    let subchannel_tokens_storage_path = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [subchannel_key].span(),
    );
    let enc_subchannel_info = user
        .compute_enc_subchannel_info(recipient: user, :token_address, index: 0, salt: salt.into());
    let expected_event_viewing_key_set = events::ViewingKeySet {
        user_addr: address, public_key, enc_private_key,
    };
    let expected_event_deposit = events::Deposit {
        user_addr: address, token: token_address, amount,
    };
    let expected_server_actions = [
        // Set viewing key.
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: public_key_storage_path, value: [public_key].span() },
        ),
        enc_private_key.to_write_once_action(storage_address: enc_private_key_storage_path),
        ServerAction::EmitViewingKeySet(expected_event_viewing_key_set),
        // Open channel.
        ServerAction::VerifyValue(
            VerifyValueInput { storage_address: public_key_storage_path, value: public_key },
        ),
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: channel_exists_storage_path, value: [true.into()].span(),
            },
        ),
        ServerAction::AppendToVec(AppendToVecInput { recipient_addr: address, enc_channel_info }),
        enc_outgoing_channel_info
            .to_write_once_action(storage_address: outgoing_channels_storage_path),
        // Open subchannel.
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address: subchannel_exists_storage_path, value: [true.into()].span(),
            },
        ),
        enc_subchannel_info.to_write_once_action(storage_address: subchannel_tokens_storage_path),
        // Deposit.
        ServerAction::TransferFrom(
            TransferFromInput { sender_addr: address, token: token_address, amount },
        ),
        ServerAction::EmitDeposit(expected_event_deposit), // Create note.
        user.note_to_server_action(note: create_note_input),
    ]
        .span();
    // Assert server actions.
    assert_eq!(server_actions, expected_server_actions);
    // Assert events. (Deposit event is not emitted since the client do not execute the deposit
    // action.)
    let events = spy_events.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        expected_event: expected_event_viewing_key_set,
        expected_event_selector: @selector!("ViewingKeySet"),
        expected_event_name: "ViewingKeySet",
    );
    // Assert view actions are the same.
    let view_actions = user.execute_view(:client_actions);
    assert_eq!(view_actions, server_actions);

    // Test CreateNote writes.
    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());
    test.privacy.execute_actions(actions: server_actions);

    let create_note = ClientAction::CreateNote(
        CreateNoteInput {
            sender_private_key: user.private_key,
            recipient_addr,
            recipient_public_key,
            token: token_address,
            amount: amount / 2,
            index: index + 1,
            salt,
        },
    );
    let client_actions = [deposit, create_note, create_note].span();
    let result = user.safe_client_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Test UseNote writes.
    let use_note = ClientAction::UseNote(
        UseNoteInput {
            owner_private_key: user.private_key,
            channel_key,
            token: token_address,
            note_index: index,
        },
    );
    let result = user.safe_client_execute(client_actions: [use_note, use_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_client_transfers_dont_execute() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let token_address = token.contract_address();
    let amount = 100;

    user.set_viewing_key_e2e();
    user.open_channel_e2e(recipient: user, index: 0);
    user.open_subchannel_e2e(recipient: user, :token_address, index: 0);

    // Deposit.
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token.balance_of(address: user.address), Zero::zero());

    let salt = user.get_salt();
    let mut spy_events_deposit = spy_events();
    let server_actions = user
        .client_execute(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_address, amount }),
                ClientAction::CreateNote(
                    CreateNoteInput {
                        sender_private_key: user.private_key,
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        token: token_address,
                        amount,
                        index: 0,
                        salt,
                    },
                ),
            ]
                .span(),
        );

    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    // Assert no events were emitted.
    assert_eq!(
        spy_events_deposit
            .get_events()
            .emitted_by(contract_address: test.privacy.address)
            .events
            .len(),
        0,
    );

    let create_note_input = CreateNoteInput {
        sender_private_key: user.private_key,
        recipient_addr: user.address,
        recipient_public_key: user.public_key,
        token: token_address,
        amount,
        index: 0,
        salt,
    };
    let expected_event = events::Deposit { user_addr: user.address, token: token_address, amount };
    let expected_server_actions = array![
        ServerAction::TransferFrom(
            TransferFromInput {
                sender_addr: user.address, token: token_address, amount: amount.into(),
            },
        ),
        ServerAction::EmitDeposit(expected_event),
        user.note_to_server_action(note: create_note_input),
    ]
        .span();
    assert_eq!(server_actions, expected_server_actions);
    let result = test.privacy.safe_execute_actions(actions: server_actions);
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());

    // Execute deposit.
    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());

    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    test.privacy.execute_actions(actions: server_actions);

    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    // Withdraw.
    let random = user.get_random().into();
    let mut spy_events_withdraw = spy_events();
    let server_actions = user
        .client_execute(
            client_actions: [
                ClientAction::UseNote(
                    UseNoteInput {
                        owner_private_key: user.private_key,
                        channel_key: user.compute_channel_key(recipient: user),
                        token: token_address,
                        note_index: 0,
                    },
                ),
                ClientAction::Withdraw(
                    WithdrawInput {
                        withdrawal_target: user.address, token: token_address, amount, random,
                    },
                ),
            ]
                .span(),
        );

    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
    // Assert no events were emitted.
    assert_eq!(
        spy_events_withdraw
            .get_events()
            .emitted_by(contract_address: test.privacy.address)
            .events
            .len(),
        0,
    );

    let nullifier = user.compute_nullifier(sender: user, :token_address, note_index: 0);
    let nullifier_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let enc_user_addr = user.compute_enc_user_addr(random: random.into());
    let expected_event = events::Withdrawal {
        enc_user_addr, withdrawal_target: user.address, token: token_address, amount,
    };
    let expected_server_actions = array![
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: nullifier_path, value: [true.into()].span() },
        ),
        ServerAction::TransferTo(
            TransferToInput {
                recipient_addr: user.address, token: token_address, amount: amount.into(),
            },
        ),
        ServerAction::EmitWithdrawal(expected_event),
    ]
        .span();
    assert_eq!(server_actions, expected_server_actions);

    test.privacy.execute_actions(actions: server_actions);
    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
}

#[test]
fn test_no_privacy_actions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let token_address = token.contract_address();
    let amount = 100;

    user.set_viewing_key_e2e();
    user.open_channel_e2e(recipient: user, index: 0);
    user.open_subchannel_e2e(recipient: user, :token_address, index: 0);

    // Empty client actions.
    let result = user.safe_client_execute(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_PRIVACY_ACTIONS);

    // Deposit only.
    let deposit_action = ClientAction::Deposit(DepositInput { token: token_address, amount });
    let result = user.safe_client_execute(client_actions: [deposit_action,].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_PRIVACY_ACTIONS);

    // Withdraw only.
    let withdraw_action = ClientAction::Withdraw(
        WithdrawInput {
            withdrawal_target: user.address,
            token: token_address,
            amount,
            random: user.get_random(),
        },
    );
    let result = user.safe_client_execute(client_actions: [withdraw_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);

    // Deposit and Withdraw.
    let result = user.safe_client_execute(client_actions: [deposit_action, withdraw_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_PRIVACY_ACTIONS);
}
