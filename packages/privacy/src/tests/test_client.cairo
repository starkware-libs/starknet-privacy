use core::num::traits::Zero;
use core::poseidon::poseidon_hash_span;
use privacy::actions::{
    AppendInput, ClientAction, CreateEncNoteInput, CreateOpenNoteInput, DepositInput,
    InvokeExternalInput, OpenChannelInput, OpenSubchannelInput, ServerAction, SetViewingKeyInput,
    TransferFromInput, TransferToInput, UseNoteInput, WithdrawInput,
};
use privacy::hashes::{compute_note_id, compute_nullifier, compute_subchannel_id};
use privacy::objects::{EncSubchannelInfo, EncUserAddr, OpenNoteDeposit};
use privacy::test_contracts::mock_swap_executor::errors as mock_swap_executor_errors;
use privacy::tests::utils_for_tests::{
    AuditorTrait, CreateEncNoteInputIntoServerActionTrait, CreateOpenNoteInputIntoServerActionTrait,
    CreateOpenNoteInputWithDepositorTrait, InvokeExternalInputIntoServerActionTrait, NoteZero,
    PrivacyCfgTrait, Test, TestTrait, UserTrait, constants, decrypt_channel_info,
    decrypt_outgoing_channel_info, decrypt_subchannel_token,
};
use privacy::utils::constants::{ESTIMATION_BASE_TX_VERSION, OPEN_NOTE_SALT, TWO_POW_120, TX_V3};
use privacy::utils::{
    compute_message_hash, decode_note_amount, encrypt_channel_info, encrypt_user_addr,
    is_canonical_key, to_write_once_action, unpack,
};
use privacy::{errors, events};
use snforge_std::{
    CheatSpan, EventSpyTrait, EventsFilterTrait, MessageToL1SpyTrait, TokenTrait, cheat_tip,
    cheat_transaction_version, get_class_hash, map_entry_address, spy_events, spy_messages_to_l1,
};
use starknet::account::Call;
use starknet::{ContractAddress, VALIDATED};
use starkware_utils::erc20::erc20_errors::Erc20Error;
use starkware_utils::errors::Describable;
use starkware_utils::span::SpanFeltsTrait;
use starkware_utils_testing::test_utils::{
    TokenHelperTrait, assert_expected_event_emitted, assert_panic_with_error,
    assert_panic_with_felt_error,
};

#[test]
fn test_validate() {
    let mut test: Test = Default::default();
    let validated = test
        .privacy
        .validate(
            user_addr: Zero::zero(), user_private_key: Zero::zero(), client_actions: [].span(),
        );
    assert_eq!(validated, VALIDATED);
    let mut user = test.new_user();
    let client_actions = [
        ClientAction::SetViewingKey(SetViewingKeyInput { random: user.get_random() })
    ]
        .span();
    let validated = test
        .privacy
        .validate(user_addr: user.address, user_private_key: user.private_key, :client_actions);
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
        to_write_once_action(storage_address: public_key_storage_path_felt, value: public_key),
        to_write_once_action(
            storage_address: enc_private_key_storage_path_felt, value: enc_private_key,
        ),
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
fn test_set_viewing_key_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let random = user.get_random();

    // Catch ZERO_PRIVATE_KEY.
    let mut user_zero_public_key = user;
    user_zero_public_key.private_key = Zero::zero();
    let result = user_zero_public_key.safe_set_viewing_key(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_public_key.safe_set_viewing_key_compile_and_panic(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_public_key.safe_set_viewing_key_compile_actions(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

    // Catch ZERO_RANDOM.
    let result = user.safe_set_viewing_key(random: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);
    let result = user.safe_set_viewing_key_compile_and_panic(random: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);
    let result = user.safe_set_viewing_key_compile_actions(random: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_key_not_canonical = user;
    user_key_not_canonical.private_key = Neg::neg(user.private_key);
    let result = user_key_not_canonical.safe_set_viewing_key(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_key_not_canonical.safe_set_viewing_key_compile_and_panic(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_key_not_canonical.safe_set_viewing_key_compile_actions(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_set_viewing_key(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero_addr.safe_set_viewing_key_compile_and_panic(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero_addr.safe_set_viewing_key_compile_actions(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch NON_ZERO_VALUE (user already registered).
    user.set_viewing_key_e2e();
    let result = user.safe_set_viewing_key(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user.safe_set_viewing_key_compile_and_panic(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user.safe_set_viewing_key_compile_actions(:random);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_set_viewing_key_decrypt_private_key() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();

    // Auditor should be able to decrypt the private key.
    let enc_private_key = user.get_enc_private_key();
    let decrypted_private_key = test.auditor.decrypt_private_key(:enc_private_key);
    assert_eq!(decrypted_private_key, user.private_key);
}

#[test]
fn test_transfer() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    user_1.open_channel_with_token_e2e(recipient: user_1, :token_addr, outgoing_channel_index: 1);
    let amount = 1;
    let index = 0;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_1, :token_addr, :amount, :index);
    user_1.cheat_create_enc_note_e2e(:create_note_input);
    let channel_key = user_1.compute_channel_key(recipient: user_1);

    let use_note_input = UseNoteInput { channel_key, token: token_addr, index };
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, :index);
    let actions = user_1
        .transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );

    let expected_nullifier = user_1.compute_nullifier(sender: user_1, :token_addr, :index);
    let (note_id, expected_note) = user_1.compute_enc_note(:create_note_input);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let mut expected_actions = array![
        to_write_once_action(storage_address: storage_path_felt_nullifier, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier: expected_nullifier }),
    ];
    expected_actions.append_span(create_note_input.into_server_actions(user: user_1));
    assert_eq!(actions, expected_actions.span());
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    test.privacy.apply_actions(:actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(:note_id), expected_note);
}

#[test]
fn test_transfer_to_self() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_1, :token_addr, outgoing_channel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_1, :token_addr, outgoing_channel_index: 0);
    let amount = 1;
    let index = 0;
    let create_note_input = user_2
        .new_enc_note_with_generated_salt(recipient: user_1, :token_addr, :amount, :index);
    user_2.cheat_create_enc_note_e2e(:create_note_input);
    let channel_key = user_2.compute_channel_key(recipient: user_1);

    let use_note_input = UseNoteInput { channel_key, token: token_addr, index };
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_1, :token_addr, :amount, :index);

    let actions = user_1
        .transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    let expected_nullifier = user_1.compute_nullifier(sender: user_2, :token_addr, :index);
    let (note_id, expected_note) = user_1.compute_enc_note(:create_note_input);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let mut expected_actions = array![
        to_write_once_action(storage_address: storage_path_felt_nullifier, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier: expected_nullifier }),
    ];
    expected_actions.append_span(create_note_input.into_server_actions(user: user_1));
    assert_eq!(actions, expected_actions.span());
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    test.privacy.apply_actions(:actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(:note_id), expected_note);
}

#[test]
fn test_transfer_use_note_and_create_same_note_twice() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_1, :token_addr, outgoing_channel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_1, :token_addr, outgoing_channel_index: 0);
    let amount = 1;
    let index = 0;
    let incoming_note = user_2
        .new_enc_note_with_generated_salt(recipient: user_1, :token_addr, :amount, :index);
    user_2.cheat_create_enc_note_e2e(create_note_input: incoming_note);
    let use_note_input = UseNoteInput {
        channel_key: user_2.compute_channel_key(recipient: user_1), token: token_addr, index,
    };
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_1, :token_addr, :amount, :index);

    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [create_note_input, create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);

    let expected_nullifier = user_1.compute_nullifier(sender: user_2, :token_addr, :index);
    let (note_id, _) = user_1.compute_enc_note(:create_note_input);
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());
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
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    user_1.open_channel_with_token_e2e(recipient: user_3, :token_addr, outgoing_channel_index: 1);
    user_1.open_channel_with_token_e2e(recipient: user_1, :token_addr, outgoing_channel_index: 2);
    let index = 0;
    let amount_1 = 1;
    let amount_2 = 8;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(
            recipient: user_1, :token_addr, amount: amount_1 + amount_2, :index,
        );
    user_1.cheat_create_enc_note_e2e(:create_note_input);
    let channel_key = user_1.compute_channel_key(recipient: user_1);

    let use_note_input = UseNoteInput { channel_key, token: token_addr, index };
    let create_note_input_1 = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, amount: amount_1, :index);
    let create_note_input_2 = user_1
        .new_enc_note_with_generated_salt(recipient: user_3, :token_addr, amount: amount_2, :index);

    let actions = user_1
        .transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [create_note_input_1, create_note_input_2].span(),
        );
    let expected_nullifier = user_1.compute_nullifier(sender: user_1, :token_addr, :index);
    let (note_id_1, expected_note_1) = user_1
        .compute_enc_note(create_note_input: create_note_input_1);
    let (note_id_2, expected_note_2) = user_1
        .compute_enc_note(create_note_input: create_note_input_2);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let mut expected_actions = array![
        to_write_once_action(storage_address: storage_path_felt_nullifier, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier: expected_nullifier }),
    ];
    expected_actions.append_span(create_note_input_1.into_server_actions(user: user_1));
    expected_actions.append_span(create_note_input_2.into_server_actions(user: user_1));
    assert_eq!(actions, expected_actions.span());
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(note_id: note_id_1), Zero::zero());
    assert_eq!(test.privacy.get_note(note_id: note_id_2), Zero::zero());

    test.privacy.apply_actions(:actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(note_id: note_id_1), expected_note_1);
    assert_eq!(test.privacy.get_note(note_id: note_id_2), expected_note_2);
}

#[test]
fn test_transfer_many_to_one() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let token_addr = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_3.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_1, :token_addr, outgoing_channel_index: 0);
    user_3.open_channel_with_token_e2e(recipient: user_1, :token_addr, outgoing_channel_index: 0);
    let amount = 1;
    let index = 0;
    let create_note_input = user_2
        .new_enc_note_with_generated_salt(recipient: user_1, :token_addr, :amount, :index);
    user_2.cheat_create_enc_note_e2e(:create_note_input);
    let channel_key_1 = user_2.compute_channel_key(recipient: user_1);
    let create_note_input = user_3
        .new_enc_note_with_generated_salt(recipient: user_1, :token_addr, :amount, :index);
    user_3.cheat_create_enc_note_e2e(:create_note_input);
    let channel_key_2 = user_3.compute_channel_key(recipient: user_1);

    let use_note_input_1 = UseNoteInput { channel_key: channel_key_1, token: token_addr, index: 0 };
    let use_note_input_2 = UseNoteInput { channel_key: channel_key_2, token: token_addr, index: 0 };
    let amount = 2 * amount;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, :index);

    let actions = user_1
        .transfer(
            notes_to_use: [use_note_input_1, use_note_input_2].span(),
            notes_to_create: [create_note_input].span(),
        );

    // Test use_note output.
    let expected_nullifier_1 = user_1.compute_nullifier(sender: user_2, :token_addr, :index);
    let expected_nullifier_2 = user_1.compute_nullifier(sender: user_3, :token_addr, :index);
    assert_ne!(expected_nullifier_1, expected_nullifier_2);
    let (note_id, expected_note) = user_1.compute_enc_note(:create_note_input);
    let storage_path_felt_nullifier_1 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_1].span(),
    );
    let storage_path_felt_nullifier_2 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_2].span(),
    );
    let mut expected_actions = array![
        to_write_once_action(storage_address: storage_path_felt_nullifier_1, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier: expected_nullifier_1 }),
        to_write_once_action(storage_address: storage_path_felt_nullifier_2, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier: expected_nullifier_2 }),
    ];
    expected_actions.append_span(create_note_input.into_server_actions(user: user_1));
    assert_eq!(actions, expected_actions.span());
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier_1));
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier_2));
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    test.privacy.apply_actions(:actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier_1));
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier_2));
    assert_eq!(test.privacy.get_note(:note_id), expected_note);
}

#[test]
fn test_transfer_many_to_many() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let token_addr = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_3.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_3, :token_addr, outgoing_channel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_3, :token_addr, outgoing_channel_index: 0);
    user_3.open_channel_with_token_e2e(recipient: user_1, :token_addr, outgoing_channel_index: 0);
    user_3.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 1);
    let amount = 1;
    let index = 0;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_3, :token_addr, :amount, :index);
    user_1.cheat_create_enc_note_e2e(:create_note_input);
    let channel_key_1 = user_1.compute_channel_key(recipient: user_3);
    let create_note_input = user_2
        .new_enc_note_with_generated_salt(recipient: user_3, :token_addr, :amount, :index);
    user_2.cheat_create_enc_note_e2e(:create_note_input);
    let channel_key_2 = user_2.compute_channel_key(recipient: user_3);

    let use_note_input_1 = UseNoteInput { channel_key: channel_key_1, token: token_addr, index: 0 };
    let use_note_input_2 = UseNoteInput { channel_key: channel_key_2, token: token_addr, index: 0 };
    let create_note_input_1 = user_3
        .new_enc_note_with_generated_salt(recipient: user_1, :token_addr, :amount, :index);
    let create_note_input_2 = user_3
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, :index);

    let actions = user_3
        .transfer(
            notes_to_use: [use_note_input_1, use_note_input_2].span(),
            notes_to_create: [create_note_input_1, create_note_input_2].span(),
        );

    let expected_nullifier_1 = user_3.compute_nullifier(sender: user_1, :token_addr, :index);
    let expected_nullifier_2 = user_3.compute_nullifier(sender: user_2, :token_addr, :index);
    assert_ne!(expected_nullifier_1, expected_nullifier_2);
    let (note_id_1, expected_note_1) = user_3
        .compute_enc_note(create_note_input: create_note_input_1);
    let (note_id_2, expected_note_2) = user_3
        .compute_enc_note(create_note_input: create_note_input_2);
    assert_ne!(note_id_1, note_id_2);
    assert_ne!(expected_note_1.packed_value, expected_note_2.packed_value);
    let storage_path_felt_nullifier_1 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_1].span(),
    );
    let storage_path_felt_nullifier_2 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_2].span(),
    );
    let mut expected_actions = array![
        to_write_once_action(storage_address: storage_path_felt_nullifier_1, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier: expected_nullifier_1 }),
        to_write_once_action(storage_address: storage_path_felt_nullifier_2, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier: expected_nullifier_2 }),
    ];
    expected_actions.append_span(create_note_input_1.into_server_actions(user: user_3));
    expected_actions.append_span(create_note_input_2.into_server_actions(user: user_3));
    assert_eq!(actions, expected_actions.span());
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier_1));
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier_2));
    assert_eq!(test.privacy.get_note(note_id: note_id_1), Zero::zero());
    assert_eq!(test.privacy.get_note(note_id: note_id_2), Zero::zero());

    test.privacy.apply_actions(:actions);
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier_1));
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier_2));
    assert_eq!(test.privacy.get_note(note_id: note_id_1), expected_note_1);
    assert_eq!(test.privacy.get_note(note_id: note_id_2), expected_note_2);
}

#[test]
fn test_transfer_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let token_addr = test.mock_new_token();
    let channel_key = user_1.compute_channel_key(recipient: user_1);

    let use_note_input = UseNoteInput { channel_key, token: token_addr, index: 0 };
    let create_note_input = CreateEncNoteInput {
        recipient_addr: user_3.address,
        recipient_public_key: user_3.public_key,
        token: token_addr,
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

    // Catch ZERO_PRIVATE_KEY.
    let mut user_1_zero_private_key = user_1;
    user_1_zero_private_key.private_key = Zero::zero();
    let result = user_1_zero_private_key
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_1_private_key_not_canonical = user_1;
    user_1_private_key_not_canonical.private_key = Neg::neg(user_1.private_key);
    let result = user_1_private_key_not_canonical
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Use note errors.

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_transfer(
            notes_to_use: [UseNoteInput { token: Zero::zero(), ..use_note_input }].span(),
            notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

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

    user_1.open_subchannel_e2e(recipient: user_1, :token_addr, index: 0);

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
    let mut user_1_wrong_private_key = user_1;
    user_1_wrong_private_key.private_key = user_2.private_key;
    let result = user_1_wrong_private_key
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Catch SUBCHANNEL_NOT_FOUND - wrong token.
    let wrong_token_addr = test.mock_new_token();
    let result = user_1
        .safe_transfer(
            notes_to_use: [UseNoteInput { token: wrong_token_addr, ..use_note_input }].span(),
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

    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_1, :token_addr, amount: 1, index: 0);
    user_1.cheat_create_enc_note_e2e(:create_note_input);

    // Catch NON_ZERO_VALUE.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input, use_note_input].span(), notes_to_create: [].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Create note errors.

    // Catch NON_ZERO_VALUE.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_3, :token_addr, amount: 1, index: 0);

    // Catch ZERO_RECIPIENT.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [
                CreateEncNoteInput { recipient_addr: Zero::zero(), ..create_note_input }
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateEncNoteInput { token: Zero::zero(), ..create_note_input }]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_RECIPIENT_PUBLIC_KEY.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [
                CreateEncNoteInput { recipient_public_key: Zero::zero(), ..create_note_input }
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);

    // Catch ZERO_SALT.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateEncNoteInput { salt: Zero::zero(), ..create_note_input }]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SALT);

    // Catch SALT_TOO_SMALL.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateEncNoteInput { salt: 1, ..create_note_input }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SALT_TOO_SMALL);

    // Catch SALT_EXCEEDS_120_BITS.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [
                CreateEncNoteInput { salt: TWO_POW_120.try_into().unwrap(), ..create_note_input }
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SALT_EXCEEDS_120_BITS);

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

    user_1.open_subchannel_e2e(recipient: user_3, :token_addr, index: 0);

    // Catch SUBCHANNEL_NOT_FOUND - wrong public key.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [
                CreateEncNoteInput { recipient_public_key: user_1.public_key, ..create_note_input }
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
    let mut user_1_wrong_private_key = user_1;
    user_1_wrong_private_key.private_key = user_2.private_key;
    let result = user_1_wrong_private_key
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Catch SUBCHANNEL_NOT_FOUND - wrong token.
    let wrong_token_addr = test.mock_new_token();
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateEncNoteInput { token: wrong_token_addr, ..create_note_input }]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Catch INDEX_NOT_SEQUENTIAL.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateEncNoteInput { index: 1, ..create_note_input }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);

    // Transfer errors.

    // Catch NEGATIVE_INTERMEDIATE_BALANCE.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateEncNoteInput { amount: 2, ..create_note_input }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);

    // Catch FINAL_BALANCE_MUST_BE_ZERO.
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(),
            notes_to_create: [CreateEncNoteInput { amount: 0, ..create_note_input }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::FINAL_BALANCE_MUST_BE_ZERO);

    // Catch again NON_ZERO_VALUE of use_note.
    let client_actions = [
        ClientAction::UseNote(use_note_input), ClientAction::CreateEncNote(create_note_input),
    ]
        .span();
    let server_actions = user_1.execute(:client_actions);
    user_1.privacy.apply_actions(actions: server_actions);
    let result = user_1
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_input].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
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
    let expected_channel_marker = user_1.compute_channel_marker(recipient: user_2);
    let channel_exists_storage_path = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_marker].span(),
    );
    let expected_outgoing_channel_id = user_1.compute_outgoing_channel_id(index: 0);
    let outgoing_channels_storage_path = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [expected_outgoing_channel_id].span(),
    );
    let expected_enc_outgoing_channel_info = user_1
        .compute_enc_outgoing_channel_info(recipient: user_2, index: 0, :salt);
    let expected_actions = [
        ServerAction::Append(
            AppendInput {
                recipient_addr: user_2.address, enc_channel_info: expected_enc_channel_info,
            },
        ),
        to_write_once_action(storage_address: channel_exists_storage_path, value: true),
        to_write_once_action(
            storage_address: outgoing_channels_storage_path,
            value: expected_enc_outgoing_channel_info,
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

    let (random, salt, channel_output) = user
        .internal_open_channel_with_generated_random_and_salt(recipient: user, index: 0);
    let channel_key = user.compute_channel_key(recipient: user);
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random,
        recipient_public_key: user.public_key,
        :channel_key,
        sender_addr: user.address,
    );
    let expected_channel_marker = user.compute_channel_marker(recipient: user);
    let channel_exists_storage_path = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_marker].span(),
    );
    let expected_outgoing_channel_id = user.compute_outgoing_channel_id(index: 0);
    let outgoing_channels_storage_path = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [expected_outgoing_channel_id].span(),
    );
    let expected_enc_outgoing_channel_info = user
        .compute_enc_outgoing_channel_info(recipient: user, index: 0, :salt);
    let expected_actions = [
        ServerAction::Append(
            AppendInput {
                recipient_addr: user.address, enc_channel_info: expected_enc_channel_info,
            },
        ),
        to_write_once_action(storage_address: channel_exists_storage_path, value: true),
        to_write_once_action(
            storage_address: outgoing_channels_storage_path,
            value: expected_enc_outgoing_channel_info,
        ),
    ]
        .span();
    assert_eq!(channel_output, expected_actions);
}

#[test]
fn test_open_channel_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let random = user_1.get_random();
    let salt = user_1.get_salt().into();
    let index = 0;

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user_1;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_open_channel(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero_addr
        .safe_open_channel_compile_and_panic(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero_addr
        .safe_open_channel_compile_actions(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch ZERO_PRIVATE_KEY.
    let mut user_zero_private_key = user_1;
    user_zero_private_key.private_key = Zero::zero();
    let result = user_zero_private_key.safe_open_channel(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_private_key
        .safe_open_channel_compile_and_panic(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_private_key
        .safe_open_channel_compile_actions(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

    // Catch ZERO_RECIPIENT_ADDR.
    let mut user_zero_addr = user_2;
    user_zero_addr.address = Zero::zero();
    let result = user_1.safe_open_channel(recipient: user_zero_addr, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);
    let result = user_1
        .safe_open_channel_compile_and_panic(recipient: user_zero_addr, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);
    let result = user_1
        .safe_open_channel_compile_actions(recipient: user_zero_addr, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_RANDOM.
    let result = user_1.safe_open_channel(recipient: user_2, :index, random: Zero::zero(), :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);
    let result = user_1
        .safe_open_channel_compile_and_panic(
            recipient: user_2, :index, random: Zero::zero(), :salt,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);
    let result = user_1
        .safe_open_channel_compile_actions(recipient: user_2, :index, random: Zero::zero(), :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);

    // Catch ZERO_SALT.
    let result = user_1.safe_open_channel(recipient: user_2, :index, :random, salt: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SALT);
    let result = user_1
        .safe_open_channel_compile_and_panic(
            recipient: user_2, :index, :random, salt: Zero::zero(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SALT);
    let result = user_1
        .safe_open_channel_compile_actions(recipient: user_2, :index, :random, salt: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SALT);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_invalid_private_key = user_1;
    user_invalid_private_key.private_key = Neg::neg(user_invalid_private_key.private_key);
    let result = user_invalid_private_key
        .safe_open_channel(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_invalid_private_key
        .safe_open_channel_compile_and_panic(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_invalid_private_key
        .safe_open_channel_compile_actions(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch SENDER_NOT_REGISTERED.
    let result = user_1.safe_open_channel(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::SENDER_NOT_REGISTERED);
    let result = user_1
        .safe_open_channel_compile_and_panic(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::SENDER_NOT_REGISTERED);
    let result = user_1
        .safe_open_channel_compile_actions(recipient: user_2, :index, :random, :salt);
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
    let result = user_1
        .safe_open_channel_compile_and_panic(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::SENDER_NOT_AUTHENTICATED);
    let result = user_1
        .safe_open_channel_compile_actions(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::SENDER_NOT_AUTHENTICATED);
    user_1.private_key = user_1_private_key;

    // Catch RECIPIENT_NOT_REGISTERED.
    let result = user_1.safe_open_channel(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::RECIPIENT_NOT_REGISTERED);
    let result = user_1
        .safe_open_channel_compile_and_panic(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::RECIPIENT_NOT_REGISTERED);
    let result = user_1
        .safe_open_channel_compile_actions(recipient: user_2, :index, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::RECIPIENT_NOT_REGISTERED);

    // Catch INDEX_NOT_SEQUENTIAL.
    user_2.set_viewing_key_e2e();
    let result = user_1.safe_open_channel(recipient: user_2, index: 1, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);
    let result = user_1
        .safe_open_channel_compile_and_panic(recipient: user_2, index: 1, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);
    let result = user_1
        .safe_open_channel_compile_actions(recipient: user_2, index: 1, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);

    // Catch NON_ZERO_VALUE (channel already exists).
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    let result = user_1.safe_open_channel(recipient: user_2, index: 1, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user_1
        .safe_open_channel_compile_and_panic(recipient: user_2, index: 0, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user_1
        .safe_open_channel_compile_actions(recipient: user_2, index: 0, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Catch NON_ZERO_VALUE (outgoing channel index already used).
    let result = user_1.safe_open_channel(recipient: user_1, index: 0, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user_1
        .safe_open_channel_compile_and_panic(recipient: user_1, index: 0, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user_1
        .safe_open_channel_compile_actions(recipient: user_1, index: 0, :random, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
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
    test.privacy.apply_actions(actions: c1_output);
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
    let expected_channel_marker_1 = user_1.compute_channel_marker(recipient: user_2);
    let expected_channel_marker_2 = user_1.compute_channel_marker(recipient: user_3);
    assert_ne!(expected_channel_marker_1, expected_channel_marker_2);
    let expected_outgoing_channel_id_1 = user_1.compute_outgoing_channel_id(index: 0);
    let expected_outgoing_channel_id_2 = user_1.compute_outgoing_channel_id(index: 1);
    assert_ne!(expected_outgoing_channel_id_1, expected_outgoing_channel_id_2);
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
    let channel_exists_storage_path_1 = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_marker_1].span(),
    );
    let channel_exists_storage_path_2 = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_marker_2].span(),
    );
    let outgoing_channels_storage_path_1 = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [expected_outgoing_channel_id_1].span(),
    );
    let outgoing_channels_storage_path_2 = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [expected_outgoing_channel_id_2].span(),
    );
    let expected_actions_1 = [
        ServerAction::Append(
            AppendInput {
                recipient_addr: user_2.address, enc_channel_info: expected_enc_channel_info_1,
            },
        ),
        to_write_once_action(storage_address: channel_exists_storage_path_1, value: true),
        to_write_once_action(
            storage_address: outgoing_channels_storage_path_1,
            value: expected_enc_outgoing_channel_info_1,
        ),
    ]
        .span();
    let expected_actions_2 = [
        ServerAction::Append(
            AppendInput {
                recipient_addr: user_3.address, enc_channel_info: expected_enc_channel_info_2,
            },
        ),
        to_write_once_action(storage_address: channel_exists_storage_path_2, value: true),
        to_write_once_action(
            storage_address: outgoing_channels_storage_path_2,
            value: expected_enc_outgoing_channel_info_2,
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
    assert_ne!(
        expected_enc_channel_info_1.ephemeral_pubkey, expected_enc_channel_info_2.ephemeral_pubkey,
    );
    assert_ne!(
        expected_enc_channel_info_1.enc_channel_key, expected_enc_channel_info_2.enc_channel_key,
    );
    assert_ne!(
        expected_enc_channel_info_1.enc_sender_addr, expected_enc_channel_info_2.enc_sender_addr,
    );
    let expected_channel_marker_1 = user_2.compute_channel_marker(recipient: user_1);
    let expected_channel_marker_2 = user_3.compute_channel_marker(recipient: user_1);
    assert_ne!(expected_channel_marker_1, expected_channel_marker_2);
    let channel_exists_storage_path_1 = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_marker_1].span(),
    );
    let channel_exists_storage_path_2 = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_marker_2].span(),
    );
    let expected_outgoing_channel_id_1 = user_2.compute_outgoing_channel_id(index: 0);
    let expected_outgoing_channel_id_2 = user_3.compute_outgoing_channel_id(index: 0);
    assert_ne!(expected_outgoing_channel_id_1, expected_outgoing_channel_id_2);
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
        map_selector: selector!("outgoing_channels"), keys: [expected_outgoing_channel_id_1].span(),
    );
    let outgoing_channels_storage_path_2 = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [expected_outgoing_channel_id_2].span(),
    );
    let expected_actions_1 = [
        ServerAction::Append(
            AppendInput {
                recipient_addr: user_1.address, enc_channel_info: expected_enc_channel_info_1,
            },
        ),
        to_write_once_action(storage_address: channel_exists_storage_path_1, value: true),
        to_write_once_action(
            storage_address: outgoing_channels_storage_path_1,
            value: expected_enc_outgoing_channel_info_1,
        ),
    ]
        .span();
    let expected_actions_2 = [
        ServerAction::Append(
            AppendInput {
                recipient_addr: user_1.address, enc_channel_info: expected_enc_channel_info_2,
            },
        ),
        to_write_once_action(storage_address: channel_exists_storage_path_2, value: true),
        to_write_once_action(
            storage_address: outgoing_channels_storage_path_2,
            value: expected_enc_outgoing_channel_info_2,
        ),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);
}

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
    let outgoing_channel_id = user_1.compute_outgoing_channel_id(index: 0);
    let enc_outgoing_channel_info = test.privacy.get_outgoing_channel_info(:outgoing_channel_id);
    let decrypted_recipient_addr = decrypt_outgoing_channel_info(
        :enc_outgoing_channel_info,
        sender_addr: user_1.address,
        sender_private_key: user_1.private_key,
        index: 0,
    );
    assert_eq!(decrypted_recipient_addr, user_2.address);
}

#[test]
fn test_open_subchannel() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, index: 0);

    let (salt, channel_output) = user_1
        .internal_open_subchannel_with_generated_salt(recipient: user_2, :token_addr, index: 0);
    let expected_subchannel_id = user_1.compute_subchannel_id(recipient: user_2, index: 0);
    let expected_enc_subchannel_info = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_addr, index: 0, :salt);
    let expected_subchannel_marker = user_1
        .compute_subchannel_marker(recipient: user_2, :token_addr);

    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_marker].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_id].span(),
    );
    let expected_actions = [
        to_write_once_action(
            storage_address: subchannel_tokens_storage_path_felt,
            value: expected_enc_subchannel_info,
        ),
        to_write_once_action(storage_address: subchannel_exists_storage_path_felt, value: true),
    ]
        .span();
    assert_eq!(channel_output, expected_actions);
}

#[test]
fn test_open_subchannel_self_channel() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user.open_channel_e2e(recipient: user, index: 0);

    let (salt, channel_output) = user
        .internal_open_subchannel_with_generated_salt(recipient: user, :token_addr, index: 0);
    let expected_subchannel_id = user.compute_subchannel_id(recipient: user, index: 0);
    let expected_enc_subchannel_info = user
        .compute_enc_subchannel_info(recipient: user, :token_addr, index: 0, :salt);
    let expected_subchannel_marker = user.compute_subchannel_marker(recipient: user, :token_addr);

    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_marker].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_id].span(),
    );
    let expected_actions = [
        to_write_once_action(
            storage_address: subchannel_tokens_storage_path_felt,
            value: expected_enc_subchannel_info,
        ),
        to_write_once_action(storage_address: subchannel_exists_storage_path_felt, value: true),
    ]
        .span();
    assert_eq!(channel_output, expected_actions);
}

#[test]
fn test_open_subchannel_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_addr = test.mock_new_token();
    let salt = user_1.get_salt().into();
    let index = 0;

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user_1;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_open_subchannel(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero_addr
        .safe_open_subchannel_compile_and_panic(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero_addr
        .safe_open_subchannel_compile_actions(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch ZERO_PRIVATE_KEY.
    let mut user_zero_private_key = user_1;
    user_zero_private_key.private_key = Zero::zero();
    let result = user_zero_private_key
        .safe_open_subchannel(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_private_key
        .safe_open_subchannel_compile_and_panic(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_private_key
        .safe_open_subchannel_compile_actions(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_private_key_not_canonical = user_1;
    user_private_key_not_canonical.private_key = Neg::neg(user_1.private_key);
    let result = user_private_key_not_canonical
        .safe_open_subchannel(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_private_key_not_canonical
        .safe_open_subchannel_compile_and_panic(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_private_key_not_canonical
        .safe_open_subchannel_compile_actions(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch ZERO_RECIPIENT_ADDR.
    let mut user_zero_addr = user_2;
    user_zero_addr.address = Zero::zero();
    let result = user_1.safe_open_subchannel(recipient: user_zero_addr, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);
    let result = user_1
        .safe_open_subchannel_compile_and_panic(
            recipient: user_zero_addr, :token_addr, :index, :salt,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);
    let result = user_1
        .safe_open_subchannel_compile_actions(
            recipient: user_zero_addr, :token_addr, :index, :salt,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_open_subchannel(recipient: user_2, token_addr: Zero::zero(), :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);
    let result = user_1
        .safe_open_subchannel_compile_and_panic(
            recipient: user_2, token_addr: Zero::zero(), :index, :salt,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);
    let result = user_1
        .safe_open_subchannel_compile_actions(
            recipient: user_2, token_addr: Zero::zero(), :index, :salt,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_SALT.
    let result = user_1
        .safe_open_subchannel(recipient: user_2, :token_addr, :index, salt: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SALT);
    let result = user_1
        .safe_open_subchannel_compile_and_panic(
            recipient: user_2, :token_addr, :index, salt: Zero::zero(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SALT);
    let result = user_1
        .safe_open_subchannel_compile_actions(
            recipient: user_2, :token_addr, :index, salt: Zero::zero(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SALT);

    // Catch ZERO_RECIPIENT_PUBLIC_KEY.
    let mut user_zero_public_key = user_2;
    user_zero_public_key.public_key = Zero::zero();
    let result = user_1
        .safe_open_subchannel(recipient: user_zero_public_key, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);
    let result = user_1
        .safe_open_subchannel_compile_and_panic(
            recipient: user_zero_public_key, :token_addr, :index, :salt,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);
    let result = user_1
        .safe_open_subchannel_compile_actions(
            recipient: user_zero_public_key, :token_addr, :index, :salt,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);

    user_2.set_viewing_key_e2e();

    // Catch INVALID_CHANNEL - sender is not registered.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);
    let result = user_1
        .safe_open_subchannel_compile_and_panic(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);
    let result = user_1
        .safe_open_subchannel_compile_actions(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    user_1.set_viewing_key_e2e();

    // Catch INVALID_CHANNEL - no channel exists for the given sender and recipient.
    let result = user_1.safe_open_subchannel(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);
    let result = user_1
        .safe_open_subchannel_compile_and_panic(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);
    let result = user_1
        .safe_open_subchannel_compile_actions(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    user_1.open_channel_e2e(recipient: user_2, index: 0);
    let channel_key = user_1.compute_channel_key(recipient: user_2);

    // Catch INVALID_CHANNEL - wrong sender_addr.
    let mut user_1_wrong_addr = user_1;
    user_1_wrong_addr.address = user_2.address;
    let result = user_1_wrong_addr
        .safe_open_subchannel(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);
    let result = user_1_wrong_addr
        .safe_open_subchannel_compile_and_panic(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);
    let result = user_1_wrong_addr
        .safe_open_subchannel_compile_actions(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INVALID_CHANNEL - wrong recipient_addr.
    let mut user_2_wrong_addr = user_2;
    user_2_wrong_addr.address = user_1.address;
    let result = user_1
        .safe_open_subchannel(recipient: user_2_wrong_addr, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);
    let result = user_1
        .safe_open_subchannel_compile_and_panic(
            recipient: user_2_wrong_addr, :token_addr, :index, :salt,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);
    let result = user_1
        .safe_open_subchannel_compile_actions(
            recipient: user_2_wrong_addr, :token_addr, :index, :salt,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INVALID_CHANNEL - wrong recipient_public_key.
    let mut user_2_wrong_public_key = user_2;
    user_2_wrong_public_key.public_key = user_1.public_key;
    let result = user_1
        .safe_open_subchannel(recipient: user_2_wrong_public_key, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);
    let result = user_1
        .safe_open_subchannel_compile_and_panic(
            recipient: user_2_wrong_public_key, :token_addr, :index, :salt,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);
    let result = user_1
        .safe_open_subchannel_compile_actions(
            recipient: user_2_wrong_public_key, :token_addr, :index, :salt,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INVALID_CHANNEL - wrong channel key.
    let result = user_1
        .safe_open_subchannel_with_channel_key(
            recipient: user_2, :token_addr, :index, :salt, channel_key: channel_key + 1,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);
    let result = user_1
        .safe_open_subchannel_with_channel_key_compile_and_panic(
            recipient: user_2, :token_addr, :index, :salt, channel_key: channel_key + 1,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);
    let result = user_1
        .safe_open_subchannel_with_channel_key_compile_actions(
            recipient: user_2, :token_addr, :index, :salt, channel_key: channel_key + 1,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    // Catch INDEX_NOT_SEQUENTIAL.
    let result = user_1
        .safe_open_subchannel(recipient: user_2, :token_addr, index: index + 1, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);
    let result = user_1
        .safe_open_subchannel_compile_and_panic(
            recipient: user_2, :token_addr, index: index + 1, :salt,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);
    let result = user_1
        .safe_open_subchannel_compile_actions(
            recipient: user_2, :token_addr, index: index + 1, :salt,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);

    // Should succeed.
    user_1.open_subchannel_e2e(recipient: user_2, :token_addr, :index);

    // Catch NON_ZERO_VALUE (subchannel already exists).
    let result = user_1.safe_open_subchannel(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user_1
        .safe_open_subchannel_compile_and_panic(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user_1
        .safe_open_subchannel_compile_actions(recipient: user_2, :token_addr, :index, :salt);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_open_subchannel_multiple() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    let token_addr_1 = test.mock_new_token();
    let token_addr_2 = test.mock_new_token();

    // Multiple subchannels with different tokens.
    let (salt_1, c1_output) = user_1
        .internal_open_subchannel_with_generated_salt(
            recipient: user_2, token_addr: token_addr_1, index: 0,
        );
    test.privacy.apply_actions(actions: c1_output);
    let (salt_2, c2_output) = user_1
        .internal_open_subchannel_with_generated_salt(
            recipient: user_2, token_addr: token_addr_2, index: 1,
        );
    let expected_subchannel_id_1 = user_1.compute_subchannel_id(recipient: user_2, index: 0);
    let expected_subchannel_id_2 = user_1.compute_subchannel_id(recipient: user_2, index: 1);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(
            recipient: user_2, token_addr: token_addr_1, index: 0, salt: salt_1,
        );
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(
            recipient: user_2, token_addr: token_addr_2, index: 1, salt: salt_2,
        );
    let expected_subchannel_marker_1 = user_1
        .compute_subchannel_marker(recipient: user_2, token_addr: token_addr_1);
    let expected_subchannel_marker_2 = user_1
        .compute_subchannel_marker(recipient: user_2, token_addr: token_addr_2);
    assert_ne!(expected_subchannel_id_1, expected_subchannel_id_2);
    assert_ne!(expected_enc_subchannel_info_1.salt, expected_enc_subchannel_info_2.salt);
    assert_ne!(expected_enc_subchannel_info_1.enc_token, expected_enc_subchannel_info_2.enc_token);
    assert_ne!(expected_subchannel_marker_1, expected_subchannel_marker_2);
    let subchannel_exists_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_marker_1].span(),
    );
    let subchannel_exists_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_marker_2].span(),
    );
    let subchannel_tokens_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_id_1].span(),
    );
    let subchannel_tokens_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_id_2].span(),
    );
    let expected_actions_1 = [
        to_write_once_action(
            storage_address: subchannel_tokens_storage_path_felt_1,
            value: expected_enc_subchannel_info_1,
        ),
        to_write_once_action(storage_address: subchannel_exists_storage_path_felt_1, value: true),
    ]
        .span();
    let expected_actions_2 = [
        to_write_once_action(
            storage_address: subchannel_tokens_storage_path_felt_2,
            value: expected_enc_subchannel_info_2,
        ),
        to_write_once_action(storage_address: subchannel_exists_storage_path_felt_2, value: true),
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
    let token_addr = test.mock_new_token();
    let (salt_1, c1_output) = user_1
        .internal_open_subchannel_with_generated_salt(recipient: user_2, :token_addr, index: 0);
    test.privacy.apply_actions(actions: c1_output);
    let (salt_2, c2_output) = user_1
        .internal_open_subchannel_with_generated_salt(recipient: user_2, :token_addr, index: 1);
    let expected_subchannel_id_1 = user_1.compute_subchannel_id(recipient: user_2, index: 0);
    let expected_subchannel_id_2 = user_1.compute_subchannel_id(recipient: user_2, index: 1);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_addr, index: 0, salt: salt_1);
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_addr, index: 1, salt: salt_2);
    // Id will be the same since the token is the same.
    let expected_subchannel_marker = user_1
        .compute_subchannel_marker(recipient: user_2, :token_addr);
    assert_ne!(expected_subchannel_id_1, expected_subchannel_id_2);
    assert_ne!(expected_enc_subchannel_info_1.salt, expected_enc_subchannel_info_2.salt);
    assert_ne!(expected_enc_subchannel_info_1.enc_token, expected_enc_subchannel_info_2.enc_token);
    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_marker].span(),
    );
    let subchannel_tokens_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_id_1].span(),
    );
    let subchannel_tokens_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_id_2].span(),
    );
    let expected_actions_1 = [
        to_write_once_action(
            storage_address: subchannel_tokens_storage_path_felt_1,
            value: expected_enc_subchannel_info_1,
        ),
        to_write_once_action(storage_address: subchannel_exists_storage_path_felt, value: true),
    ]
        .span();
    let expected_actions_2 = [
        to_write_once_action(
            storage_address: subchannel_tokens_storage_path_felt_2,
            value: expected_enc_subchannel_info_2,
        ),
        to_write_once_action(storage_address: subchannel_exists_storage_path_felt, value: true),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);
    let result = test.privacy.safe_apply_actions(actions: c2_output);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Multiple subchannels with the same index (fails only on the server side).
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    let (salt_1, c1_output) = user_1
        .internal_open_subchannel_with_generated_salt(
            recipient: user_2, token_addr: token_addr_1, index: 0,
        );
    test.privacy.apply_actions(actions: c1_output);
    let (salt_2, c2_output) = user_1
        .internal_open_subchannel_with_generated_salt(
            recipient: user_2, token_addr: token_addr_2, index: 0,
        );
    // Id will be the same since the index is the same.
    let expected_subchannel_id = user_1.compute_subchannel_id(recipient: user_2, index: 0);
    let expected_enc_subchannel_info_1 = user_1
        .compute_enc_subchannel_info(
            recipient: user_2, token_addr: token_addr_1, index: 0, salt: salt_1,
        );
    let expected_enc_subchannel_info_2 = user_1
        .compute_enc_subchannel_info(
            recipient: user_2, token_addr: token_addr_2, index: 0, salt: salt_2,
        );
    let expected_subchannel_marker_1 = user_1
        .compute_subchannel_marker(recipient: user_2, token_addr: token_addr_1);
    let expected_subchannel_marker_2 = user_1
        .compute_subchannel_marker(recipient: user_2, token_addr: token_addr_2);
    assert_ne!(expected_enc_subchannel_info_1.salt, expected_enc_subchannel_info_2.salt);
    assert_ne!(expected_enc_subchannel_info_1.enc_token, expected_enc_subchannel_info_2.enc_token);
    assert_ne!(expected_subchannel_marker_1, expected_subchannel_marker_2);
    let subchannel_exists_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_marker_1].span(),
    );
    let subchannel_exists_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_marker_2].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_id].span(),
    );
    let expected_actions_1 = [
        to_write_once_action(
            storage_address: subchannel_tokens_storage_path_felt,
            value: expected_enc_subchannel_info_1,
        ),
        to_write_once_action(storage_address: subchannel_exists_storage_path_felt_1, value: true),
    ]
        .span();
    let expected_actions_2 = [
        to_write_once_action(
            storage_address: subchannel_tokens_storage_path_felt,
            value: expected_enc_subchannel_info_2,
        ),
        to_write_once_action(storage_address: subchannel_exists_storage_path_felt_2, value: true),
    ]
        .span();
    assert_eq!(c1_output, expected_actions_1);
    assert_eq!(c2_output, expected_actions_2);
    let result = test.privacy.safe_apply_actions(actions: c2_output);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_open_subchannel_multiple_self_channel() {
    let mut test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let token_addr_1 = test.mock_new_token();
    let token_addr_2 = test.mock_new_token();
    user.open_channel_e2e(recipient: user, index: 0);

    // Multiple subchannels with different tokens.
    let (salt_1, c1_output) = user
        .internal_open_subchannel_with_generated_salt(
            recipient: user, token_addr: token_addr_1, index: 0,
        );
    test.privacy.apply_actions(actions: c1_output);
    let (salt_2, c2_output) = user
        .internal_open_subchannel_with_generated_salt(
            recipient: user, token_addr: token_addr_2, index: 1,
        );
    let expected_subchannel_id_1 = user.compute_subchannel_id(recipient: user, index: 0);
    let expected_subchannel_id_2 = user.compute_subchannel_id(recipient: user, index: 1);
    let expected_enc_subchannel_info_1 = user
        .compute_enc_subchannel_info(
            recipient: user, token_addr: token_addr_1, index: 0, salt: salt_1,
        );
    let expected_enc_subchannel_info_2 = user
        .compute_enc_subchannel_info(
            recipient: user, token_addr: token_addr_2, index: 1, salt: salt_2,
        );
    let expected_subchannel_marker_1 = user
        .compute_subchannel_marker(recipient: user, token_addr: token_addr_1);
    let expected_subchannel_marker_2 = user
        .compute_subchannel_marker(recipient: user, token_addr: token_addr_2);
    assert_ne!(expected_subchannel_id_1, expected_subchannel_id_2);
    assert_ne!(expected_enc_subchannel_info_1.salt, expected_enc_subchannel_info_2.salt);
    assert_ne!(expected_enc_subchannel_info_1.enc_token, expected_enc_subchannel_info_2.enc_token);
    assert_ne!(expected_subchannel_marker_1, expected_subchannel_marker_2);
    let subchannel_exists_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_marker_1].span(),
    );
    let subchannel_exists_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_marker_2].span(),
    );
    let subchannel_tokens_storage_path_felt_1 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_id_1].span(),
    );
    let subchannel_tokens_storage_path_felt_2 = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_id_2].span(),
    );
    let expected_actions_1 = [
        to_write_once_action(
            storage_address: subchannel_tokens_storage_path_felt_1,
            value: expected_enc_subchannel_info_1,
        ),
        to_write_once_action(storage_address: subchannel_exists_storage_path_felt_1, value: true),
    ]
        .span();
    let expected_actions_2 = [
        to_write_once_action(
            storage_address: subchannel_tokens_storage_path_felt_2,
            value: expected_enc_subchannel_info_2,
        ),
        to_write_once_action(storage_address: subchannel_exists_storage_path_felt_2, value: true),
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
    let token_addr = test.mock_new_token();
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    user_1.open_subchannel_e2e(recipient: user_2, :token_addr, index: 0);

    // User 2 should be able to decrypt the subchannel info (the token).
    // User 2 decrypts the channel_key.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (decrypted_channel_key, _) = decrypt_channel_info(
        :enc_channel_info, recipient_private_key: user_2.private_key,
    );
    // User 2 decrypts the subchannel token.
    let subchannel_id = compute_subchannel_id(channel_key: decrypted_channel_key, index: 0);
    let enc_subchannel_info = test.privacy.get_subchannel_info(:subchannel_id);
    let decrypted_token = decrypt_subchannel_token(
        :enc_subchannel_info, channel_key: decrypted_channel_key, index: 0,
    );
    assert_eq!(decrypted_token, token_addr);
}

#[test]
fn test_create_note_self_note() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user.open_channel_with_token_e2e(recipient: user, :token_addr, outgoing_channel_index: 0);
    let amount = 1;
    let index = 0;
    let create_note_input = user
        .new_enc_note_with_generated_salt(recipient: user, :token_addr, :amount, :index);
    let actions = user.internal_create_enc_note(:create_note_input);
    assert_eq!(actions, create_note_input.into_server_actions(:user));

    // Create open note.
    let create_note_input = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, :index);
    let actions = user.internal_create_open_note(:create_note_input);
    assert_eq!(actions, create_note_input.into_server_actions(:user));
}

#[test]
fn test_create_note_twice() {
    // Tests all 4 combinations: enc→enc, enc→open, open→open, open→enc
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token = test.new_token();
    let token_addr = token.contract_address();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let amount_1 = 1;
    let open_note_amount = constants::DEFAULT_AMOUNT;

    // Note 1: encrypted note at index 0.
    let create_note_input_1 = user_1
        .new_enc_note_with_generated_salt(
            recipient: user_2, :token_addr, amount: amount_1, index: 0,
        );
    let create_note_1_actions = user_1
        .internal_create_enc_note(create_note_input: create_note_input_1);
    assert_eq!(create_note_1_actions, create_note_input_1.into_server_actions(user: user_1));
    user_1.privacy.apply_actions(actions: create_note_1_actions);

    // Note 2: encrypted note at index 1 (enc → enc).
    let amount_2 = amount_1 + 1;
    let create_note_input_2 = user_1
        .new_enc_note_with_generated_salt(
            recipient: user_2, :token_addr, amount: amount_2, index: 1,
        );
    let create_note_2_actions = user_1
        .internal_create_enc_note(create_note_input: create_note_input_2);
    assert_eq!(create_note_2_actions, create_note_input_2.into_server_actions(user: user_1));
    user_1.privacy.apply_actions(actions: create_note_2_actions);

    // Note 3: open note at index 2 (enc → open). Create+deposit via echo executor.
    let note_3 = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 2);
    let create_note_3_actions = user_1.internal_create_open_note(create_note_input: note_3);
    assert_eq!(create_note_3_actions, note_3.into_server_actions(user: user_1));
    let note_id_3 = user_1
        .create_and_deposit_to_open_note_e2e(
            create_note_input: note_3, amount: open_note_amount, :token,
        );

    // Note 4: open note at index 3 (open → open). Create+deposit via echo executor.
    let note_4 = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 3);
    let create_note_4_actions = user_1.internal_create_open_note(create_note_input: note_4);
    assert_eq!(create_note_4_actions, note_4.into_server_actions(user: user_1));
    let note_id_4 = user_1
        .create_and_deposit_to_open_note_e2e(
            create_note_input: note_4, amount: open_note_amount, :token,
        );

    // Note 5: encrypted note at index 4 (open → enc).
    let amount_5 = amount_2 + 1;
    let note_5 = user_1
        .new_enc_note_with_generated_salt(
            recipient: user_2, :token_addr, amount: amount_5, index: 4,
        );
    let create_note_5_actions = user_1.internal_create_enc_note(create_note_input: note_5);
    assert_eq!(create_note_5_actions, note_5.into_server_actions(user: user_1));
    user_1.privacy.apply_actions(actions: create_note_5_actions);

    // Verify all note IDs are unique.
    let (note_id_1, expected_note_1) = user_1
        .compute_enc_note(create_note_input: create_note_input_1);
    let (note_id_2, expected_note_2) = user_1
        .compute_enc_note(create_note_input: create_note_input_2);
    let (note_id_5, expected_note_5) = user_1.compute_enc_note(create_note_input: note_5);
    [note_id_1, note_id_2, note_id_3, note_id_4, note_id_5].span().assert_unique_felts();

    // Verify deposited open notes have the same packed_value (same salt + amount).
    let stored_note_3 = user_1.privacy.get_note(note_id: note_id_3);
    let stored_note_4 = user_1.privacy.get_note(note_id: note_id_4);
    assert_eq!(stored_note_3.packed_value, stored_note_4.packed_value);

    // Verify encrypted create_note_input values are unique (and differ from open note
    // value).
    [
        expected_note_1.packed_value, expected_note_2.packed_value, stored_note_3.packed_value,
        expected_note_5.packed_value,
    ]
        .span()
        .assert_unique_felts();
}

#[test]
fn test_create_note_twice_same_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let amount = 1;
    let index_1 = 0;
    let create_note_input_1 = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, index: index_1);
    let create_note_1_actions = user_1
        .internal_create_enc_note(create_note_input: create_note_input_1);
    let index_2 = index_1 + 1;
    test.privacy.apply_actions(actions: create_note_1_actions);
    let create_note_input_2 = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, index: index_2);
    let create_note_2_actions = user_1
        .internal_create_enc_note(create_note_input: create_note_input_2);
    let (note_id_1, expected_note_1) = user_1
        .compute_enc_note(create_note_input: create_note_input_1);
    let (note_id_2, expected_note_2) = user_1
        .compute_enc_note(create_note_input: create_note_input_2);
    assert_ne!(note_id_1, note_id_2);
    assert_ne!(expected_note_1.packed_value, expected_note_2.packed_value);
    assert_eq!(create_note_1_actions, create_note_input_1.into_server_actions(user: user_1));
    assert_eq!(create_note_2_actions, create_note_input_2.into_server_actions(user: user_1));
}

#[test]
fn test_create_enc_note_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token_addr = test.mock_new_token();
    user.set_viewing_key_e2e();
    let create_note_input = user
        .new_enc_note_with_generated_salt(recipient: user, :token_addr, amount: 1, index: 0);

    // Catch ZERO_USER_ADDR.
    let mut user_zero = user;
    user_zero.address = Zero::zero();
    let result = user_zero.safe_create_enc_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero.safe_create_enc_note_compile_and_panic(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero.safe_create_enc_note_compile_actions(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch ZERO_PRIVATE_KEY.
    let mut user_zero_private_key = user;
    user_zero_private_key.private_key = Zero::zero();
    let result = user_zero_private_key.safe_create_enc_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_private_key.safe_create_enc_note_compile_and_panic(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_private_key.safe_create_enc_note_compile_actions(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_private_key_not_canonical = user;
    user_private_key_not_canonical.private_key = Neg::neg(user.private_key);
    let result = user_private_key_not_canonical.safe_create_enc_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_private_key_not_canonical
        .safe_create_enc_note_compile_and_panic(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_private_key_not_canonical
        .safe_create_enc_note_compile_actions(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch ZERO_RECIPIENT_ADDR.
    let result = user
        .safe_create_enc_note(
            create_note_input: CreateEncNoteInput {
                recipient_addr: Zero::zero(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);
    let result = user
        .safe_create_enc_note_compile_and_panic(
            create_note_input: CreateEncNoteInput {
                recipient_addr: Zero::zero(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);
    let result = user
        .safe_create_enc_note_compile_actions(
            create_note_input: CreateEncNoteInput {
                recipient_addr: Zero::zero(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_TOKEN.
    let result = user
        .safe_create_enc_note(
            create_note_input: CreateEncNoteInput { token: Zero::zero(), ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);
    let result = user
        .safe_create_enc_note_compile_and_panic(
            create_note_input: CreateEncNoteInput { token: Zero::zero(), ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);
    let result = user
        .safe_create_enc_note_compile_actions(
            create_note_input: CreateEncNoteInput { token: Zero::zero(), ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_RECIPIENT_PUBLIC_KEY.
    let result = user
        .safe_create_enc_note(
            create_note_input: CreateEncNoteInput {
                recipient_public_key: Zero::zero(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);
    let result = user
        .safe_create_enc_note_compile_and_panic(
            create_note_input: CreateEncNoteInput {
                recipient_public_key: Zero::zero(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);
    let result = user
        .safe_create_enc_note_compile_actions(
            create_note_input: CreateEncNoteInput {
                recipient_public_key: Zero::zero(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);

    // Catch ZERO_SALT.
    let result = user
        .safe_create_enc_note(
            create_note_input: CreateEncNoteInput { salt: Zero::zero(), ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SALT);
    let result = user
        .safe_create_enc_note_compile_and_panic(
            create_note_input: CreateEncNoteInput { salt: Zero::zero(), ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SALT);
    let result = user
        .safe_create_enc_note_compile_actions(
            create_note_input: CreateEncNoteInput { salt: Zero::zero(), ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SALT);

    // Catch SALT_TOO_SMALL.
    let result = user
        .safe_create_enc_note(
            create_note_input: CreateEncNoteInput { salt: 1, ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SALT_TOO_SMALL);

    let result = user
        .safe_create_enc_note_compile_and_panic(
            create_note_input: CreateEncNoteInput { salt: 1, ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SALT_TOO_SMALL);

    let result = user
        .safe_create_enc_note_compile_actions(
            create_note_input: CreateEncNoteInput { salt: 1, ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SALT_TOO_SMALL);

    // Catch SALT_EXCEEDS_120_BITS.
    let result = user
        .safe_create_enc_note(
            create_note_input: CreateEncNoteInput {
                salt: TWO_POW_120.try_into().unwrap(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SALT_EXCEEDS_120_BITS);
    let result = user
        .safe_create_enc_note_compile_and_panic(
            create_note_input: CreateEncNoteInput {
                salt: TWO_POW_120.try_into().unwrap(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SALT_EXCEEDS_120_BITS);
    let result = user
        .safe_create_enc_note_compile_actions(
            create_note_input: CreateEncNoteInput {
                salt: TWO_POW_120.try_into().unwrap(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SALT_EXCEEDS_120_BITS);

    // Catch SUBCHANNEL_NOT_FOUND (channel doesnt exist).
    let result = user.safe_create_enc_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
    let result = user.safe_create_enc_note_compile_and_panic(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
    let result = user.safe_create_enc_note_compile_actions(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    user.open_channel_e2e(recipient: user, index: 0);

    // Catch SUBCHANNEL_NOT_FOUND (subchannel doesnt exist).
    let result = user.safe_create_enc_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
    let result = user.safe_create_enc_note_compile_and_panic(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
    let result = user.safe_create_enc_note_compile_actions(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    user.open_subchannel_e2e(recipient: user, :token_addr, index: 0);

    // Catch INDEX_NOT_SEQUENTIAL.
    let result = user
        .safe_create_enc_note(
            create_note_input: CreateEncNoteInput { index: 1, ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);
    let result = user
        .safe_create_enc_note_compile_and_panic(
            create_note_input: CreateEncNoteInput { index: 1, ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);
    let result = user
        .safe_create_enc_note_compile_actions(
            create_note_input: CreateEncNoteInput { index: 1, ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);

    // Catch NEGATIVE_INTERMEDIATE_BALANCE.
    let result = user.safe_create_enc_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);
    let result = user.safe_create_enc_note_compile_and_panic(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);
    let result = user.safe_create_enc_note_compile_actions(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);

    user.cheat_create_enc_note_e2e(:create_note_input);

    // Catch NON_ZERO_VALUE (note id already exists).
    let use_note_input = UseNoteInput {
        channel_key: user.compute_channel_key(recipient: user),
        token: create_note_input.token,
        index: create_note_input.index,
    };
    let client_actions = [
        ClientAction::UseNote(use_note_input), ClientAction::CreateEncNote(create_note_input),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_create_open_note_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token_addr = test.mock_new_token();
    user.set_viewing_key_e2e();
    let create_note_input = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, index: 0);

    // Catch ZERO_USER_ADDR.
    let mut user_zero = user;
    user_zero.address = Zero::zero();
    let result = user_zero.safe_create_open_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero.safe_create_open_note_compile_and_panic(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero.safe_create_open_note_compile_actions(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch ZERO_PRIVATE_KEY.
    let mut user_zero_private_key = user;
    user_zero_private_key.private_key = Zero::zero();
    let result = user_zero_private_key.safe_create_open_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_private_key.safe_create_open_note_compile_and_panic(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_private_key.safe_create_open_note_compile_actions(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_private_key_not_canonical = user;
    user_private_key_not_canonical.private_key = Neg::neg(user.private_key);
    let result = user_private_key_not_canonical.safe_create_open_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_private_key_not_canonical
        .safe_create_open_note_compile_and_panic(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_private_key_not_canonical
        .safe_create_open_note_compile_actions(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch ZERO_RECIPIENT_ADDR.
    let result = user
        .safe_create_open_note(
            create_note_input: CreateOpenNoteInput {
                recipient_addr: Zero::zero(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);
    let result = user
        .safe_create_open_note_compile_and_panic(
            create_note_input: CreateOpenNoteInput {
                recipient_addr: Zero::zero(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);
    let result = user
        .safe_create_open_note_compile_actions(
            create_note_input: CreateOpenNoteInput {
                recipient_addr: Zero::zero(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_ADDR);

    // Catch ZERO_TOKEN.
    let result = user
        .safe_create_open_note(
            create_note_input: CreateOpenNoteInput { token: Zero::zero(), ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);
    let result = user
        .safe_create_open_note_compile_and_panic(
            create_note_input: CreateOpenNoteInput { token: Zero::zero(), ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);
    let result = user
        .safe_create_open_note_compile_actions(
            create_note_input: CreateOpenNoteInput { token: Zero::zero(), ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_RECIPIENT_PUBLIC_KEY.
    let result = user
        .safe_create_open_note(
            create_note_input: CreateOpenNoteInput {
                recipient_public_key: Zero::zero(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);
    let result = user
        .safe_create_open_note_compile_and_panic(
            create_note_input: CreateOpenNoteInput {
                recipient_public_key: Zero::zero(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);
    let result = user
        .safe_create_open_note_compile_actions(
            create_note_input: CreateOpenNoteInput {
                recipient_public_key: Zero::zero(), ..create_note_input,
            },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RECIPIENT_PUBLIC_KEY);

    // Catch SUBCHANNEL_NOT_FOUND (channel doesnt exist).
    let result = user.safe_create_open_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
    let result = user.safe_create_open_note_compile_and_panic(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
    let result = user.safe_create_open_note_compile_actions(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    user.open_channel_e2e(recipient: user, index: 0);

    // Catch SUBCHANNEL_NOT_FOUND (subchannel doesnt exist).
    let result = user.safe_create_open_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
    let result = user.safe_create_open_note_compile_and_panic(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
    let result = user.safe_create_open_note_compile_actions(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    user.open_subchannel_e2e(recipient: user, :token_addr, index: 0);

    // Catch INDEX_NOT_SEQUENTIAL.
    let result = user
        .safe_create_open_note(
            create_note_input: CreateOpenNoteInput { index: 1, ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);
    let result = user
        .safe_create_open_note_compile_and_panic(
            create_note_input: CreateOpenNoteInput { index: 1, ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);
    let result = user
        .safe_create_open_note_compile_actions(
            create_note_input: CreateOpenNoteInput { index: 1, ..create_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INDEX_NOT_SEQUENTIAL);

    user.cheat_create_open_note(:create_note_input);

    // Catch NON_ZERO_VALUE (note id already exists).
    let client_actions = [ClientAction::CreateOpenNote(create_note_input),].span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_create_and_use_encrypted_note_zero_amount() {
    // Creating an encrypted note with amount=0 is allowed, but using it should fail.
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_addr = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    // Create note with zero amount - this should succeed.
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, amount: 0, index: 0);
    let server_actions = user_1.create_enc_note(:create_note_input);
    let (note_id, expected_note) = user_1.compute_enc_note(:create_note_input);
    assert_ne!(note_id, Zero::zero());
    assert_ne!(expected_note.packed_value, Zero::zero());
    assert_eq!(server_actions, create_note_input.into_server_actions(user: user_1));
    assert_eq!(user_1.privacy.get_note(:note_id), Zero::zero());
    user_1.privacy.apply_actions(actions: server_actions);
    assert_eq!(user_1.privacy.get_note(:note_id), expected_note);
    // Attempt to use note with zero amount - should fail with ZERO_NOTE_AMOUNT_USAGE.
    let use_note_input = UseNoteInput {
        channel_key: user_1.compute_channel_key(recipient: user_2), token: token_addr, index: 0,
    };
    let result = user_2.safe_use_note(note: use_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_NOTE_AMOUNT_USAGE);
}

#[test]
fn test_create_note_subchannel_not_found_wrong_addr() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);

    // Encrypted note.
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, amount: 1, index: 0);
    user_1.address = user_2.address;
    let result = user_1.safe_create_enc_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Open note.
    let create_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0);
    let result = user_1.safe_create_open_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
}

#[test]
fn test_create_note_subchannel_not_found_wrong_private_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    user_1.new_key();

    // Encrypted note.
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, amount: 1, index: 0);
    let result = user_1.safe_create_enc_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Open note.
    let create_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0);
    let result = user_1.safe_create_open_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
}

#[test]
fn test_create_note_subchannel_not_found_wrong_public_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    user_2.public_key = user_1.public_key;

    // Encrypted note.
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, amount: 1, index: 0);
    let result = user_1.safe_create_enc_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Open note.
    let create_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0);
    let result = user_1.safe_create_open_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
}

#[test]
fn test_create_note_subchannel_not_found_wrong_token() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let wrong_token_addr = test.mock_new_token();

    // Encrypted note.
    let mut create_note_input = user_1
        .new_enc_note_with_generated_salt(
            recipient: user_2, token_addr: wrong_token_addr, amount: 1, index: 0,
        );
    let result = user_1.safe_create_enc_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Open note.
    let create_note_input = user_1
        .new_open_note_with_generated_random(
            recipient: user_2, token_addr: wrong_token_addr, index: 0,
        );
    let result = user_1.safe_create_open_note(:create_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
}

#[test]
fn test_create_note_decrypt_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let amount = 1;
    let index = 0;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, :index);
    let create_note_actions = user_1.internal_create_enc_note(:create_note_input);
    user_1.privacy.apply_actions(actions: create_note_actions);

    // User 2 should be able to decrypt the amount.
    // Decrypt channel key.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (channel_key, _) = decrypt_channel_info(
        :enc_channel_info, recipient_private_key: user_2.private_key,
    );
    let note_id = compute_note_id(:channel_key, token: token_addr, :index);
    let note = user_2.privacy.get_note(:note_id);
    let dec_note_amount = decode_note_amount(
        packed_value: note.packed_value, :channel_key, token: token_addr, :index,
    );
    assert_eq!(dec_note_amount, amount);
}

#[test]
fn test_create_open_note_stores_correctly() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token = test.new_token();
    let token_addr = token.contract_address();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let index = 0;
    let amount = constants::DEFAULT_AMOUNT;
    let create_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, :index);
    // Create and deposit to the open note.
    let note_id = user_1.create_and_deposit_to_open_note_e2e(:create_note_input, :amount, :token);

    // Verify the note struct was stored correctly (including token field).
    let stored_note = user_1.privacy.get_note(:note_id);
    assert_eq!(stored_note.token, token_addr);
    let (salt, stored_amount) = unpack(packed_value: stored_note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, amount);
}

#[test]
fn test_create_enc_note_stores_one_felt() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let index = 0;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, amount: 100, :index);
    let create_note_actions = user_1.internal_create_enc_note(:create_note_input);
    user_1.privacy.apply_actions(actions: create_note_actions);

    // Verify the token field was stored correctly.
    let (note_id, expected_note) = user_1.compute_enc_note(:create_note_input);
    assert_eq!(user_1.privacy.get_note(:note_id), expected_note);
}

#[test]
#[test_case(true)]
#[test_case(false)]
fn test_use_deposited_open_note(open_note_self: bool) {
    // Test using a deposited open note in a transfer.
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = if open_note_self {
        user_1
    } else {
        test.new_user()
    };
    let mut user_3 = test.new_user();
    user_1.set_viewing_key_e2e();
    if !open_note_self {
        user_2.set_viewing_key_e2e();
    }
    user_3.set_viewing_key_e2e();

    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = constants::DEFAULT_AMOUNT;

    // Setup channels: user_1 -> user_2, user_2 -> user_3.
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let outgoing_channel_index = if open_note_self {
        1
    } else {
        0
    };
    user_2.open_channel_with_token_e2e(recipient: user_3, :token_addr, :outgoing_channel_index);

    // Create an open note for user_2 from user_1.
    let index = 0;
    let create_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, :index);
    user_1.create_and_deposit_to_open_note_e2e(:create_note_input, :amount, :token);

    // Verify the note now has the deposited amount (use unpack to ensure it's an open note).
    let (note_id, _) = user_1.compute_open_note(:create_note_input);
    let stored_note = test.privacy.get_note(:note_id);
    let (salt, stored_amount) = unpack(packed_value: stored_note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, amount);

    // Now user_2 uses the deposited open note to transfer to user_3.
    let channel_key_1_to_2 = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput { channel_key: channel_key_1_to_2, token: token_addr, index };
    let create_enc_note = user_2
        .new_enc_note_with_generated_salt(recipient: user_3, :token_addr, :amount, index: 0);
    let actions = user_2
        .transfer(notes_to_use: [use_note_input].span(), notes_to_create: [create_enc_note].span());

    // Verify the note and nullifier do not exist yet.
    let expected_nullifier = user_2.compute_nullifier(sender: user_1, :token_addr, :index);
    let (new_note_id, expected_note) = user_2.compute_enc_note(create_note_input: create_enc_note);
    assert!(!test.privacy.nullifier_exists(nullifier: expected_nullifier));
    assert_eq!(test.privacy.get_note(note_id: new_note_id), Zero::zero());

    // Execute the transfer.
    test.privacy.apply_actions(:actions);

    // Verify nullifier was created (note is spent).
    assert!(test.privacy.nullifier_exists(nullifier: expected_nullifier));

    // Verify the new encrypted note was created.
    assert_eq!(test.privacy.get_note(note_id: new_note_id), expected_note);
}

#[test]
fn test_use_deposited_open_note_withdraw() {
    // Test using a deposited open note for withdrawal.
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();

    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = 100_u128;

    // Setup channel: user_1 -> user_2.
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);

    // Create an open note for user_2.
    let index = 0;
    let create_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, :index);
    user_1.create_and_deposit_to_open_note_e2e(:create_note_input, :amount, :token);

    // Verify contract now has the tokens.
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    // User 2 withdraws using the deposited open note.
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    user_2
        .withdraw_and_use_note_e2e(
            to_addr: user_2.address, :token_addr, :amount, :channel_key, :index,
        );

    // Verify tokens were transferred to user_2.
    assert_eq!(token.balance_of(address: user_2.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    // Verify nullifier was created.
    let nullifier = user_2.compute_nullifier(sender: user_1, :token_addr, :index);
    assert!(test.privacy.nullifier_exists(:nullifier));
}

#[test]
fn test_use_multiple_deposited_open_notes() {
    // Test merging multiple deposited open notes in a single transfer.
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_3.set_viewing_key_e2e();

    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount_1 = 100_u128;
    let amount_2 = 200_u128;
    let total_amount = amount_1 + amount_2;

    // Setup channels: user_1 -> user_2, user_2 -> user_3.
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_3, :token_addr, outgoing_channel_index: 0);

    // Create two open notes for user_2 at different indices.
    let create_note_input_1 = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0);
    let create_note_input_2 = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 1);
    user_1
        .create_and_deposit_to_open_note_e2e(
            create_note_input: create_note_input_1, amount: amount_1, :token,
        );
    user_1
        .create_and_deposit_to_open_note_e2e(
            create_note_input: create_note_input_2, amount: amount_2, :token,
        );

    // User_2 uses both notes in a single transfer to create one merged note for user_3.
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_1 = UseNoteInput { channel_key, token: token_addr, index: 0 };
    let use_note_2 = UseNoteInput { channel_key, token: token_addr, index: 1 };
    let create_enc_note = user_2
        .new_enc_note_with_generated_salt(
            recipient: user_3, :token_addr, amount: total_amount, index: 0,
        );

    let actions = user_2
        .transfer(
            notes_to_use: [use_note_1, use_note_2].span(),
            notes_to_create: [create_enc_note].span(),
        );
    test.privacy.apply_actions(:actions);

    // Verify both nullifiers were created.
    let nullifier_1 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 0);
    let nullifier_2 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 1);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_1));
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_2));

    // Verify the merged note was created with total amount.
    let (new_note_id, expected_note) = user_2.compute_enc_note(create_note_input: create_enc_note);
    assert_eq!(test.privacy.get_note(note_id: new_note_id), expected_note);
}

#[test]
fn test_use_mixed_open_and_enc_notes() {
    // Test using a mix of encrypted and open notes in the same transfer.
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_3.set_viewing_key_e2e();

    let token = test.new_token();
    let token_addr = token.contract_address();
    let enc_amount = 50_u128;
    let open_amount = 75_u128;
    let total_amount = enc_amount + open_amount;

    // Setup channels.
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_3, :token_addr, outgoing_channel_index: 0);

    // Create an encrypted note at index 0 for user_2.
    let enc_note_input = user_1
        .new_enc_note_with_generated_salt(
            recipient: user_2, :token_addr, amount: enc_amount, index: 0,
        );
    user_1.cheat_create_enc_note_e2e(create_note_input: enc_note_input);

    // Create an open note at index 1 for user_2.
    let open_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 1);
    user_1
        .create_and_deposit_to_open_note_e2e(
            create_note_input: open_note_input, amount: open_amount, :token,
        );

    // User_2 uses both notes (one encrypted, one open) in a transfer to user_3.
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_enc_note = UseNoteInput { channel_key, token: token_addr, index: 0 };
    let use_open_note = UseNoteInput { channel_key, token: token_addr, index: 1 };
    let create_output_note = user_2
        .new_enc_note_with_generated_salt(
            recipient: user_3, :token_addr, amount: total_amount, index: 0,
        );

    let actions = user_2
        .transfer(
            notes_to_use: [use_enc_note, use_open_note].span(),
            notes_to_create: [create_output_note].span(),
        );
    test.privacy.apply_actions(:actions);

    // Verify both nullifiers created.
    let nullifier_enc = user_2.compute_nullifier(sender: user_1, :token_addr, index: 0);
    let nullifier_open = user_2.compute_nullifier(sender: user_1, :token_addr, index: 1);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_enc));
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_open));

    // Verify output note created with combined amount.
    let (output_note_id, expected_output) = user_2
        .compute_enc_note(create_note_input: create_output_note);
    assert_eq!(test.privacy.get_note(note_id: output_note_id), expected_output);
}

#[test]
fn test_use_deposited_open_note_double_spend() {
    // Test that a deposited open note cannot be spent twice.
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_3.set_viewing_key_e2e();

    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = 100_u128;

    // Setup channels.
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_3, :token_addr, outgoing_channel_index: 0);

    // Create and fund an open note.
    let create_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0);
    user_1.create_and_deposit_to_open_note_e2e(:create_note_input, :amount, :token);

    // First spend: user_2 uses the note successfully.
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput { channel_key, token: token_addr, index: 0 };
    let create_note_1 = user_2
        .new_enc_note_with_generated_salt(recipient: user_3, :token_addr, :amount, index: 0);
    let actions = user_2
        .transfer(notes_to_use: [use_note_input].span(), notes_to_create: [create_note_1].span());
    test.privacy.apply_actions(:actions);

    // Verify nullifier was created.
    let nullifier = user_2.compute_nullifier(sender: user_1, :token_addr, index: 0);
    assert!(test.privacy.nullifier_exists(:nullifier));

    // Second spend attempt: should fail with NON_ZERO_VALUE (nullifier already exists).
    let create_note_2 = user_2
        .new_enc_note_with_generated_salt(recipient: user_3, :token_addr, :amount, index: 1);
    let result = user_2
        .safe_transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [create_note_2].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
#[feature("safe_dispatcher")]
fn test_deposit_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token_addr = test.mock_new_token();
    let amount = 100;

    // Catch ZERO_TOKEN.
    let result = user.safe_deposit(token_addr: Zero::zero(), :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT.
    let result = user.safe_deposit(:token_addr, amount: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);
}

#[test]
fn test_use_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let amount = 1;
    let index = 0;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, :index);
    user_1.cheat_create_enc_note_e2e(:create_note_input);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput { channel_key, token: token_addr, index };
    let actions = user_2.internal_use_note(note: use_note_input);
    let nullifier = user_2.compute_nullifier(sender: user_1, :token_addr, :index);
    let nullifier_storage_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let expected_actions = [
        to_write_once_action(storage_address: nullifier_storage_path, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier }),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_use_note_self_note() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user.open_channel_with_token_e2e(recipient: user, :token_addr, outgoing_channel_index: 0);
    let amount = 1;
    let index = 0;
    let create_note_input = user
        .new_enc_note_with_generated_salt(recipient: user, :token_addr, :amount, :index);
    user.cheat_create_enc_note_e2e(:create_note_input);
    let channel_key = user.compute_channel_key(recipient: user);
    let use_note_input = UseNoteInput { channel_key, token: token_addr, index };
    let actions = user.internal_use_note(note: use_note_input);
    let nullifier = user.compute_nullifier(sender: user, :token_addr, :index);
    let nullifier_storage_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let expected_actions = [
        to_write_once_action(storage_address: nullifier_storage_path, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier }),
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
    let token_addr = test.mock_new_token();
    user_2.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let amount_1 = 1;
    let amount_2 = 2;
    let create_note_input_1 = user_1
        .new_enc_note_with_generated_salt(
            recipient: user_2, :token_addr, amount: amount_1, index: 0,
        );
    let create_note_input_2 = user_1
        .new_enc_note_with_generated_salt(
            recipient: user_2, :token_addr, amount: amount_2, index: 1,
        );
    let create_note_input_3 = user_2
        .new_enc_note_with_generated_salt(
            recipient: user_2, :token_addr, amount: amount_1, index: 0,
        );
    user_1.cheat_create_enc_note_e2e(create_note_input: create_note_input_1);
    user_1.cheat_create_enc_note_e2e(create_note_input: create_note_input_2);
    user_2.cheat_create_enc_note_e2e(create_note_input: create_note_input_3);
    let channel_key_1 = user_1.compute_channel_key(recipient: user_2);
    let channel_key_2 = user_2.compute_channel_key(recipient: user_2);
    let note_1_path = UseNoteInput { channel_key: channel_key_1, token: token_addr, index: 0 };
    let note_2_path = UseNoteInput { channel_key: channel_key_1, token: token_addr, index: 1 };
    let note_3_path = UseNoteInput { channel_key: channel_key_2, token: token_addr, index: 0 };
    let actions_1 = user_2.internal_use_note(note: note_1_path);
    let actions_2 = user_2.internal_use_note(note: note_2_path);
    let actions_3 = user_2.internal_use_note(note: note_3_path);
    let expected_nullifier_1 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 0);
    let expected_nullifier_2 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 1);
    let expected_nullifier_3 = user_2.compute_nullifier(sender: user_2, :token_addr, index: 0);
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
        to_write_once_action(storage_address: nullifier_storage_path_1, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier: expected_nullifier_1 }),
    ]
        .span();
    let expected_actions_2 = [
        to_write_once_action(storage_address: nullifier_storage_path_2, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier: expected_nullifier_2 }),
    ]
        .span();
    let expected_actions_3 = [
        to_write_once_action(storage_address: nullifier_storage_path_3, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier: expected_nullifier_3 }),
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
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let amount = 1;
    let index = 0;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, :index);
    user_1.cheat_create_enc_note_e2e(:create_note_input);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput { channel_key, token: token_addr, index };
    let use_note_action = ClientAction::UseNote(use_note_input);
    let client_actions = [use_note_action, use_note_action].span();
    // Should panic on the second use.
    user_2.execute(:client_actions);
}

#[test]
fn test_use_note_same_amount() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let amount = 1;
    let create_note_input_1 = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, index: 0);
    let create_note_input_2 = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, index: 1);
    user_1.cheat_create_enc_note_e2e(create_note_input: create_note_input_1);
    user_1.cheat_create_enc_note_e2e(create_note_input: create_note_input_2);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input_1 = UseNoteInput { channel_key, token: token_addr, index: 0 };
    let use_note_input_2 = UseNoteInput { channel_key, token: token_addr, index: 1 };
    let actions_1 = user_2.internal_use_note(note: use_note_input_1);
    let actions_2 = user_2.internal_use_note(note: use_note_input_2);
    let expected_nullifier_1 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 0);
    let expected_nullifier_2 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 1);
    let nullifier_storage_path_1 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_1].span(),
    );
    let nullifier_storage_path_2 = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier_2].span(),
    );
    let expected_actions_1 = [
        to_write_once_action(storage_address: nullifier_storage_path_1, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier: expected_nullifier_1 }),
    ]
        .span();
    let expected_actions_2 = [
        to_write_once_action(storage_address: nullifier_storage_path_2, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier: expected_nullifier_2 }),
    ]
        .span();
    assert_eq!(actions_1, expected_actions_1);
    assert_eq!(actions_2, expected_actions_2);
}

#[test]
fn test_use_note_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    user.set_viewing_key_e2e();
    user.open_channel_with_token_e2e(recipient: user, :token_addr, outgoing_channel_index: 0);
    let create_note_input = user
        .new_enc_note_with_generated_salt(recipient: user, :token_addr, amount: 1, index: 0);
    user.cheat_create_enc_note_e2e(:create_note_input);

    let channel_key = user.compute_channel_key(recipient: user);
    let use_note_input = UseNoteInput { channel_key, token: token_addr, index: 0 };

    // Catch ZERO_USER_ADDR.
    let mut user_zero = user;
    user_zero.address = Zero::zero();
    let result = user_zero.safe_use_note(note: use_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero.safe_use_note_compile_and_panic(note: use_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero.safe_use_note_compile_actions(note: use_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch ZERO_PRIVATE_KEY.
    let mut user_zero_private_key = user;
    user_zero_private_key.private_key = Zero::zero();
    let result = user_zero_private_key.safe_use_note(note: use_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_private_key.safe_use_note_compile_and_panic(note: use_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_private_key.safe_use_note_compile_actions(note: use_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_private_key_not_canonical = user;
    user_private_key_not_canonical.private_key = Neg::neg(user.private_key);
    let result = user_private_key_not_canonical.safe_use_note(note: use_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_private_key_not_canonical
        .safe_use_note_compile_and_panic(note: use_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_private_key_not_canonical.safe_use_note_compile_actions(note: use_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch ZERO_TOKEN.
    let result = user.safe_use_note(note: UseNoteInput { token: Zero::zero(), ..use_note_input });
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);
    let result = user
        .safe_use_note_compile_and_panic(
            note: UseNoteInput { token: Zero::zero(), ..use_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);
    let result = user
        .safe_use_note_compile_actions(
            note: UseNoteInput { token: Zero::zero(), ..use_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch SUBCHANNEL_NOT_FOUND (wrong channel key).
    let wrong_channel_key = channel_key + 1;
    let result = user
        .safe_use_note(note: UseNoteInput { channel_key: wrong_channel_key, ..use_note_input });
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
    let result = user
        .safe_use_note_compile_and_panic(
            note: UseNoteInput { channel_key: wrong_channel_key, ..use_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
    let result = user
        .safe_use_note_compile_actions(
            note: UseNoteInput { channel_key: wrong_channel_key, ..use_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Catch SUBCHANNEL_NOT_FOUND (wrong token).
    let wrong_token_addr = test.mock_new_token();
    let result = user
        .safe_use_note(note: UseNoteInput { token: wrong_token_addr, ..use_note_input });
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
    let result = user
        .safe_use_note_compile_and_panic(
            note: UseNoteInput { token: wrong_token_addr, ..use_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
    let result = user
        .safe_use_note_compile_actions(
            note: UseNoteInput { token: wrong_token_addr, ..use_note_input },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    // Ctach NOTE_NOT_FOUND (wrong note index).
    let result = user.safe_use_note(note: UseNoteInput { index: 1, ..use_note_input });
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);
    let result = user
        .safe_use_note_compile_and_panic(note: UseNoteInput { index: 1, ..use_note_input });
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);
    let result = user
        .safe_use_note_compile_actions(note: UseNoteInput { index: 1, ..use_note_input });
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    // Catch NON_ZERO_VALUE (nullifier already exists).
    let client_actions = [
        ClientAction::UseNote(use_note_input),
        ClientAction::CreateEncNote(
            CreateEncNoteInput {
                recipient_addr: user.address,
                recipient_public_key: user.public_key,
                token: token_addr,
                amount: create_note_input.amount,
                index: create_note_input.index + 1,
                salt: create_note_input.salt + 1,
            },
        ),
    ]
        .span();
    let server_actions = user.execute(:client_actions);
    user.privacy.apply_actions(actions: server_actions);
    let result = user.safe_use_note(note: use_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user.safe_use_note_compile_and_panic(note: use_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user.safe_use_note_compile_actions(note: use_note_input);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
#[should_panic(expected: 'SUBCHANNEL_NOT_FOUND')]
fn test_use_note_wrong_owner_addr() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    user_2.open_channel_e2e(recipient: user_1, index: 0);
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, amount: 1, index: 0);
    user_1.cheat_create_enc_note_e2e(:create_note_input);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput { channel_key, token: token_addr, index: 0 };
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
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let amount = 1;
    let index = 0;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, :index);
    user_1.cheat_create_enc_note_e2e(:create_note_input);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    user_2.new_key();
    let use_note_input = UseNoteInput { channel_key, token: token_addr, index };
    user_2.use_note(note: use_note_input);
}

#[test]
fn test_use_note_find_nullifier() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let amount = 1;
    let index = 0;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, :index);
    user_1.cheat_create_enc_note_e2e(:create_note_input);

    // User 2 should be able to find the nullifier.
    let enc_channel_info = user_2.get_channel_info(channel_index: 0);
    let (channel_key, _) = decrypt_channel_info(
        :enc_channel_info, recipient_private_key: user_2.private_key,
    );
    let expected_nullifier = compute_nullifier(
        :channel_key, token: token_addr, :index, owner_private_key: user_2.private_key,
    );
    assert!(!user_2.privacy.nullifier_exists(nullifier: expected_nullifier));

    // User 2 uses the note.
    let use_note_input = UseNoteInput { channel_key, token: token_addr, index };
    let actions = user_2.internal_use_note(note: use_note_input);
    let nullifier_storage_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [expected_nullifier].span(),
    );
    let expected_actions = [
        to_write_once_action(storage_address: nullifier_storage_path, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier: expected_nullifier }),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    user_2.privacy.cheat_use_note(nullifier: expected_nullifier);

    assert!(user_2.privacy.nullifier_exists(nullifier: expected_nullifier));
}

#[test]
fn test_withdraw_different_targets() {
    let mut test = Default::default();
    let token_addr = test.mock_new_token();
    let amount = 100;

    // Setup users.
    let mut user_1 = test.new_user(); // Owner.
    let mut user_2 = test.new_user(); // Registered user.
    let user_3 = test.new_user(); // Not registered.
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_1, :token_addr, outgoing_channel_index: 0);

    // Withdraw note to self.
    let (random, actions) = user_1
        .internal_withdraw_with_generated_random(to_addr: user_1.address, :token_addr, :amount);
    let enc_user_addr = user_1.compute_enc_user_addr(:random);
    let expected_actions = [
        ServerAction::TransferTo(
            TransferToInput { to_addr: user_1.address, token: token_addr, amount },
        ),
        ServerAction::EmitWithdrawal(
            events::Withdrawal {
                enc_user_addr, to_addr: user_1.address, token: token_addr, amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Withdraw note to other registered user.
    let (random, actions) = user_1
        .internal_withdraw_with_generated_random(to_addr: user_2.address, :token_addr, :amount);
    let enc_user_addr = user_1.compute_enc_user_addr(:random);
    let expected_actions = [
        ServerAction::TransferTo(
            TransferToInput { to_addr: user_2.address, token: token_addr, amount },
        ),
        ServerAction::EmitWithdrawal(
            events::Withdrawal {
                enc_user_addr, to_addr: user_2.address, token: token_addr, amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Withdraw note to not registered user.
    let (random, actions) = user_1
        .internal_withdraw_with_generated_random(to_addr: user_3.address, :token_addr, :amount);
    let enc_user_addr = user_1.compute_enc_user_addr(:random);
    let expected_actions = [
        ServerAction::TransferTo(
            TransferToInput { to_addr: user_3.address, token: token_addr, amount },
        ),
        ServerAction::EmitWithdrawal(
            events::Withdrawal {
                enc_user_addr, to_addr: user_3.address, token: token_addr, amount,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_withdraw_assertions() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_addr = test.mock_new_token();
    let amount = 100;
    let random = user_1.get_random().into();

    // Catch ZERO_TO_ADDR.
    let result = user_1.safe_withdraw(to_addr: Zero::zero(), :token_addr, :amount, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TO_ADDR);

    // Catch ZERO_TOKEN.
    let result = user_1
        .safe_withdraw(to_addr: user_2.address, token_addr: Zero::zero(), :amount, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT.
    let result = user_1
        .safe_withdraw(to_addr: user_2.address, :token_addr, amount: Zero::zero(), :random);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);

    // Catch ZERO_RANDOM.
    let result = user_1
        .safe_withdraw(to_addr: user_2.address, :token_addr, :amount, random: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_RANDOM);

    // Catch NEGATIVE_INTERMEDIATE_BALANCE.
    let result = user_1.safe_withdraw(to_addr: user_2.address, :token_addr, :amount, :random);
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);
}

#[test]
fn test_withdraw_decrypt_user_addr() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    // Setup.
    user_1.set_viewing_key_e2e();
    let token = test.new_token();
    let token_addr = token.contract_address();
    user_1.open_channel_with_token_e2e(recipient: user_1, :token_addr, outgoing_channel_index: 0);
    // Initialize: deposit + create note.
    let amount = 100;
    user_1.deposit_and_create_note_e2e(:token, :amount);
    // Use note + withdraw.
    let channel_key = user_1.compute_channel_key(recipient: user_1);
    let mut spy_events = spy_events();
    user_1
        .withdraw_and_use_note_e2e(
            to_addr: user_1.address, :token_addr, :amount, :channel_key, index: 0,
        );

    // Auditor should be able to decrypt the user address.
    let events = spy_events.get_events().emitted_by(contract_address: test.privacy.address).events;
    // events[0]: NoteUsed from apply_actions.
    // events[1]: Withdrawal from apply_actions.
    assert_eq!(events.len(), 2);
    let nullifier = user_1.compute_nullifier(sender: user_1, :token_addr, index: 0);
    let expected_note_used = events::NoteUsed { nullifier };
    assert_expected_event_emitted(
        spied_event: events[0],
        expected_event: expected_note_used,
        expected_event_selector: @selector!("NoteUsed"),
        expected_event_name: "NoteUsed",
    );
    let (_, event) = events[1];
    let enc_user_addr = EncUserAddr {
        auditor_public_key: *event.data[0],
        ephemeral_pubkey: *event.data[1],
        enc_user_addr: *event.data[2],
    };
    let decrypted_user_addr = test.auditor.decrypt_user_addr(:enc_user_addr);
    assert_eq!(decrypted_user_addr, user_1.address);
}

#[test]
fn test_create_open_note_decrypt_recipient_addr() {
    let mut test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    // Setup.
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = constants::DEFAULT_AMOUNT;
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    // Create an open note (with deposit, so the enforcement passes and events are emitted).
    let create_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0);
    let mut spy_events = spy_events();
    user_1.create_and_deposit_to_open_note_e2e(:create_note_input, :amount, :token);

    // Auditor should be able to decrypt the sender address from the OpenNoteCreated event.
    let events = spy_events.get_events().emitted_by(contract_address: test.privacy.address).events;
    // events[0]: OpenNoteCreated from apply_actions.
    // events[1]: OpenNoteDeposited from apply_actions.
    assert_eq!(events.len(), 2);
    let (_, event) = events[0];
    let enc_recipient_addr = EncUserAddr {
        auditor_public_key: *event.data[0],
        ephemeral_pubkey: *event.data[1],
        enc_user_addr: *event.data[2],
    };
    let decrypted_recipient_addr = test
        .auditor
        .decrypt_user_addr(enc_user_addr: enc_recipient_addr);
    assert_eq!(decrypted_recipient_addr, user_2.address);
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
fn test_execute_set_viewing_key() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();

    let random = user_1.get_random();
    let client_actions = [ClientAction::SetViewingKey(SetViewingKeyInput { random })].span();
    let mut spy = spy_events();
    let actions = user_1.execute(:client_actions);
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 0);
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
        to_write_once_action(
            storage_address: public_key_storage_path_felt, value: user_1.public_key,
        ),
        to_write_once_action(
            storage_address: enc_private_key_storage_path_felt, value: enc_private_key,
        ),
        ServerAction::EmitViewingKeySet(expected_event),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    let mut spy = spy_events();
    let view_actions = user_1.compile_actions(:client_actions);
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 0);
    assert_eq!(view_actions, actions);
    let mut spy = spy_events();
    let panic_data_actions = user_1.compile_and_panic(:client_actions);
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 0);
    assert_eq!(panic_data_actions, actions);
    assert_eq!(user_1.get_public_key(), Zero::zero());
    assert_eq!(user_1.get_enc_private_key().ephemeral_pubkey, Zero::zero());
    assert_eq!(user_1.get_enc_private_key().enc_private_key, Zero::zero());

    let mut spy_events = spy_events();
    test.privacy.apply_actions(:actions);
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

    // Try to apply the same action again.
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_open_channel() {
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
            OpenChannelInput { recipient_addr: user_2.address, index: 0, random, salt },
        )
    ]
        .span();
    let actions = user_1.execute(:client_actions);
    let expected_channel_marker = user_1.compute_channel_marker(recipient: user_2);
    let expected_channel_key = user_1.compute_channel_key(recipient: user_2);
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random,
        recipient_public_key: user_2.public_key,
        channel_key: expected_channel_key,
        sender_addr: user_1.address,
    );
    let expected_outgoing_channel_id = user_1.compute_outgoing_channel_id(index: 0);
    let expected_enc_outgoing_channel_info = user_1
        .compute_enc_outgoing_channel_info(recipient: user_2, index: 0, :salt);
    let channel_exists_storage_path = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_marker].span(),
    );
    let outgoing_channels_storage_path = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [expected_outgoing_channel_id].span(),
    );
    let expected_actions = [
        ServerAction::Append(
            AppendInput {
                recipient_addr: user_2.address, enc_channel_info: expected_enc_channel_info,
            },
        ),
        to_write_once_action(storage_address: channel_exists_storage_path, value: true),
        to_write_once_action(
            storage_address: outgoing_channels_storage_path,
            value: expected_enc_outgoing_channel_info,
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    let view_actions = user_1.compile_actions(:client_actions);
    assert_eq!(view_actions, actions);
    let panic_data_actions = user_1.compile_and_panic(:client_actions);
    assert_eq!(panic_data_actions, actions);
    assert!(!test.privacy.channel_exists(channel_marker: expected_channel_marker));
    assert_eq!(user_2.get_num_of_channels(), 0);
    let result = user_2.safe_get_channel_info(channel_index: 0);
    assert_panic_with_error(:result, expected_error: "Index out of bounds");
    assert_eq!(user_1.get_num_of_channels(), 0);

    test.privacy.apply_actions(:actions);
    assert!(test.privacy.channel_exists(channel_marker: expected_channel_marker));
    assert_eq!(user_2.get_num_of_channels(), 1);
    assert_eq!(user_2.get_channel_info(channel_index: 0), expected_enc_channel_info);
    assert_eq!(user_1.get_num_of_channels(), 0);
    assert_eq!(
        test.privacy.get_outgoing_channel_info(outgoing_channel_id: expected_outgoing_channel_id),
        expected_enc_outgoing_channel_info,
    );

    // Try to apply the same action again.
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_open_subchannel() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_addr = test.mock_new_token();
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
                token: token_addr,
                salt,
            },
        ),
    ]
        .span();
    let actions = user_1.execute(:client_actions);
    let expected_subchannel_marker = user_1
        .compute_subchannel_marker(recipient: user_2, :token_addr);
    let expected_subchannel_id = user_1.compute_subchannel_id(recipient: user_2, index: 0);
    let expected_enc_subchannel_info = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_addr, index: 0, :salt);
    let subchannel_exists_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [expected_subchannel_marker].span(),
    );
    let subchannel_tokens_storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [expected_subchannel_id].span(),
    );
    let expected_actions = [
        to_write_once_action(
            storage_address: subchannel_tokens_storage_path_felt,
            value: expected_enc_subchannel_info,
        ),
        to_write_once_action(storage_address: subchannel_exists_storage_path_felt, value: true),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    let view_actions = user_1.compile_actions(:client_actions);
    assert_eq!(view_actions, actions);
    let panic_data_actions = user_1.compile_and_panic(:client_actions);
    assert_eq!(panic_data_actions, actions);
    assert!(!test.privacy.subchannel_exists(subchannel_marker: expected_subchannel_marker));
    assert_eq!(
        test.privacy.get_subchannel_info(subchannel_id: expected_subchannel_id),
        EncSubchannelInfo { salt: Zero::zero(), enc_token: Zero::zero() },
    );

    test.privacy.apply_actions(:actions);
    assert!(test.privacy.subchannel_exists(subchannel_marker: expected_subchannel_marker));
    assert_eq!(
        test.privacy.get_subchannel_info(subchannel_id: expected_subchannel_id),
        expected_enc_subchannel_info,
    );

    // Try to apply the same action again.
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_deposit_create_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);

    let amount = 100;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, index: 0);
    user_1.open_subchannel_e2e(recipient: user_2, :token_addr, index: 0);
    user_1.increase_token_balance(:token, :amount);
    user_1.approve(:token, amount: amount.into());
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::CreateEncNote(create_note_input),
    ]
        .span();
    let actions = user_1.execute(:client_actions);
    let (note_id, expected_note) = user_1.compute_enc_note(:create_note_input);
    let expected_event = events::Deposit { user_addr: user_1.address, token: token_addr, amount };
    let mut expected_actions = array![
        ServerAction::TransferFrom(
            TransferFromInput {
                from_addr: user_1.address, token: token_addr, amount: amount.into(),
            },
        ),
        ServerAction::EmitDeposit(expected_event),
    ];
    expected_actions.append_span(create_note_input.into_server_actions(user: user_1));
    assert_eq!(actions, expected_actions.span());
    let view_actions = user_1.compile_actions(:client_actions);
    assert_eq!(view_actions, actions);
    let panic_data_actions = user_1.compile_and_panic(:client_actions);
    assert_eq!(panic_data_actions, actions);
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());
    assert_eq!(token.balance_of(address: user_1.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    test.privacy.apply_actions(:actions);
    assert_eq!(test.privacy.get_note(:note_id), expected_note);
    assert_eq!(token.balance_of(address: user_1.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    // Try to apply the same action again.
    user_1.increase_token_balance(:token, :amount);
    user_1.approve(:token, amount: amount.into());
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_use_note_create_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_addr = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    user_1.open_subchannel_e2e(recipient: user_2, :token_addr, index: 0);

    let amount = 100;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, index: 0);
    user_1.cheat_create_enc_note_e2e(:create_note_input);
    let use_note_input = UseNoteInput {
        channel_key: user_1.compute_channel_key(recipient: user_2),
        token: token_addr,
        index: create_note_input.index,
    };
    let create_note_input_2 = user_2
        .new_enc_note_with_generated_salt(recipient: user_1, :token_addr, :amount, index: 0);
    user_2.open_channel_e2e(recipient: user_1, index: 0);
    user_2.open_subchannel_e2e(recipient: user_1, :token_addr, index: 0);
    let client_actions = [
        ClientAction::UseNote(use_note_input), ClientAction::CreateEncNote(create_note_input_2),
    ]
        .span();
    let mut spy = spy_events();
    let actions = user_2.execute(:client_actions);
    let execute_events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(execute_events.len(), 0);
    let nullifier = user_2
        .compute_nullifier(sender: user_1, :token_addr, index: create_note_input.index);
    let (note_id, expected_note) = user_2.compute_enc_note(create_note_input: create_note_input_2);
    let nullifier_storage_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let mut expected_actions = array![
        to_write_once_action(storage_address: nullifier_storage_path, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier }),
    ];
    expected_actions.append_span(create_note_input_2.into_server_actions(user: user_2));
    assert_eq!(actions, expected_actions.span());
    let mut spy = spy_events();
    let view_actions = user_2.compile_actions(:client_actions);
    let compile_actions_events = spy
        .get_events()
        .emitted_by(contract_address: test.privacy.address)
        .events;
    assert_eq!(compile_actions_events.len(), 0);
    assert_eq!(view_actions, actions);
    let mut spy = spy_events();
    let panic_data_actions = user_2.compile_and_panic(:client_actions);
    let compile_and_panic_events = spy
        .get_events()
        .emitted_by(contract_address: test.privacy.address)
        .events;
    assert_eq!(compile_and_panic_events.len(), 0);
    assert_eq!(panic_data_actions, actions);
    assert!(!test.privacy.nullifier_exists(:nullifier));
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    test.privacy.apply_actions(:actions);
    assert!(test.privacy.nullifier_exists(:nullifier));
    assert_eq!(test.privacy.get_note(:note_id), expected_note);

    // Try to apply the same action again.
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_use_note_withdraw() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    user_1.open_subchannel_e2e(recipient: user_2, :token_addr, index: 0);
    let amount = 100;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, index: 0);
    user_1.cheat_create_enc_note_e2e(:create_note_input);
    test.privacy.increase_token_balance(:token, :amount);

    let use_note_input = UseNoteInput {
        channel_key: user_1.compute_channel_key(recipient: user_2),
        token: token_addr,
        index: create_note_input.index,
    };
    let random = user_2.get_random().into();
    let client_actions = [
        ClientAction::UseNote(use_note_input),
        ClientAction::Withdraw(
            WithdrawInput { to_addr: user_1.address, token: token_addr, amount, random },
        ),
    ]
        .span();
    let nullifier = user_2
        .compute_nullifier(sender: user_1, :token_addr, index: create_note_input.index);
    let mut spy = spy_events();
    let actions = user_2.execute(:client_actions);
    let execute_events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(execute_events.len(), 0);
    let nullifier_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let enc_user_addr = user_2.compute_enc_user_addr(:random);
    let expected_event = events::Withdrawal {
        enc_user_addr, to_addr: user_1.address, token: token_addr, amount,
    };
    let expected_actions = array![
        to_write_once_action(storage_address: nullifier_path, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier }),
        ServerAction::TransferTo(
            TransferToInput { to_addr: user_1.address, token: token_addr, amount },
        ),
        ServerAction::EmitWithdrawal(expected_event),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    let mut spy = spy_events();
    let view_actions = user_2.compile_actions(:client_actions);
    let compile_actions_events = spy
        .get_events()
        .emitted_by(contract_address: test.privacy.address)
        .events;
    assert_eq!(compile_actions_events.len(), 0);
    assert_eq!(view_actions, actions);
    let mut spy = spy_events();
    let panic_data_actions = user_2.compile_and_panic(:client_actions);
    let compile_and_panic_events = spy
        .get_events()
        .emitted_by(contract_address: test.privacy.address)
        .events;
    assert_eq!(compile_and_panic_events.len(), 0);
    assert_eq!(panic_data_actions, actions);
    assert!(!test.privacy.nullifier_exists(:nullifier));
    assert_eq!(token.balance_of(address: user_1.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    test.privacy.apply_actions(:actions);
    assert!(test.privacy.nullifier_exists(:nullifier));
    assert_eq!(token.balance_of(address: user_1.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    // Try to apply the same action again.
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_use_note_swap() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    user.set_viewing_key_e2e();
    user.open_channel_with_token_e2e(recipient: user, :token_addr, outgoing_channel_index: 0);
    let amount = 100;
    let create_note_input = user
        .new_enc_note_with_generated_salt(recipient: user, :token_addr, :amount, index: 0);
    user.cheat_create_enc_note_e2e(:create_note_input);
    let out_token = test.new_token();
    let out_token_addr = out_token.contract_address();
    user.open_subchannel_e2e(recipient: user, token_addr: out_token_addr, index: 1);
    let create_open_note_input = user
        .new_open_note_with_generated_random(recipient: user, token_addr: out_token_addr, index: 0)
        .with_depositor(depositor: test.privacy.swap_executor.address);
    test.privacy.increase_token_balance(:token, :amount);

    let channel_key = user.compute_channel_key(recipient: user);
    let use_note_input = UseNoteInput {
        channel_key, token: token_addr, index: create_note_input.index,
    };
    let note_id = compute_note_id(
        :channel_key, token: out_token_addr, index: create_open_note_input.index,
    );
    let invoke_external_input = user
        .invoke_external_mock_swap_executor_input(
            in_token: token_addr, out_token: out_token_addr, :amount, :note_id,
        );
    let random = user.get_random();
    let withdraw_input = WithdrawInput {
        to_addr: test.privacy.swap_executor.address, token: token_addr, amount, random,
    };
    let client_actions = [
        ClientAction::UseNote(use_note_input), ClientAction::CreateOpenNote(create_open_note_input),
        ClientAction::Withdraw(withdraw_input), ClientAction::InvokeExternal(invoke_external_input),
    ]
        .span();
    let nullifier = user
        .compute_nullifier(sender: user, :token_addr, index: create_note_input.index);
    let mut spy = spy_events();
    let actions = user.execute(:client_actions);
    let execute_events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(execute_events.len(), 0);
    let nullifier_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let enc_user_addr = user.compute_enc_user_addr(:random);
    let note_id = compute_note_id(
        :channel_key, token: out_token_addr, index: create_open_note_input.index,
    );
    let create_open_note_actions = create_open_note_input.into_server_actions(:user);
    let mut expected_actions: Array<ServerAction> = array![
        to_write_once_action(storage_address: nullifier_path, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier }),
    ];
    expected_actions.append_span(create_open_note_actions);
    expected_actions
        .append(
            ServerAction::TransferTo(
                TransferToInput {
                    to_addr: test.privacy.swap_executor.address, token: token_addr, amount,
                },
            ),
        );
    expected_actions
        .append(
            ServerAction::EmitWithdrawal(
                events::Withdrawal {
                    enc_user_addr,
                    to_addr: test.privacy.swap_executor.address,
                    token: token_addr,
                    amount,
                },
            ),
        );
    expected_actions.append(invoke_external_input.into_server_action());
    assert_eq!(actions, expected_actions.span());
    let mut spy = spy_events();
    let view_actions = user.compile_actions(:client_actions);
    let compile_actions_events = spy
        .get_events()
        .emitted_by(contract_address: test.privacy.address)
        .events;
    assert_eq!(compile_actions_events.len(), 0);
    assert_eq!(view_actions, actions);
    let mut spy = spy_events();
    let panic_data_actions = user.compile_and_panic(:client_actions);
    let compile_and_panic_events = spy
        .get_events()
        .emitted_by(contract_address: test.privacy.address)
        .events;
    assert_eq!(compile_and_panic_events.len(), 0);
    assert_eq!(panic_data_actions, actions);
    assert!(!test.privacy.nullifier_exists(:nullifier));
    let note = test.privacy.get_note(:note_id);
    assert_eq!(note, Zero::zero());
    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.swap_executor.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.mock_amm), Zero::zero());

    out_token.supply(address: test.privacy.mock_amm, :amount);

    let mut spy = spy_events();
    test.privacy.apply_actions(:actions);
    assert!(test.privacy.nullifier_exists(:nullifier));
    let note = test.privacy.get_note(:note_id);
    let (salt, note_amount) = unpack(packed_value: note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(note_amount, amount);
    assert_eq!(note.token, out_token_addr);
    assert_eq!(out_token.balance_of(address: user.address), Zero::zero());
    assert_eq!(out_token.balance_of(address: test.privacy.address), amount.into());
    assert_eq!(out_token.balance_of(address: test.privacy.swap_executor.address), Zero::zero());
    assert_eq!(out_token.balance_of(address: test.privacy.mock_amm), Zero::zero());
    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.swap_executor.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.mock_amm), amount.into());
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 4);
    assert_expected_event_emitted(
        spied_event: events[0],
        expected_event: events::NoteUsed { nullifier },
        expected_event_selector: @selector!("NoteUsed"),
        expected_event_name: "NoteUsed",
    );
    let enc_recipient_addr = encrypt_user_addr(
        ephemeral_secret: create_open_note_input.random,
        auditor_public_key: test.privacy.get_auditor_public_key(),
        user_addr: user.address,
    );
    let expected_event_open_note_created = events::OpenNoteCreated {
        enc_recipient_addr,
        depositor: create_open_note_input.depositor,
        token: out_token_addr,
        note_id,
    };
    assert_expected_event_emitted(
        spied_event: events[1],
        expected_event: expected_event_open_note_created,
        expected_event_selector: @selector!("OpenNoteCreated"),
        expected_event_name: "OpenNoteCreated",
    );
    let expected_event_withdrawal = events::Withdrawal {
        enc_user_addr, to_addr: test.privacy.swap_executor.address, token: token_addr, amount,
    };
    assert_expected_event_emitted(
        spied_event: events[2],
        expected_event: expected_event_withdrawal,
        expected_event_selector: @selector!("Withdrawal"),
        expected_event_name: "Withdrawal",
    );
    let expected_event_deposit_to_open_note = events::OpenNoteDeposited {
        depositor: test.privacy.swap_executor.address, token: out_token_addr, note_id, amount,
    };
    assert_expected_event_emitted(
        spied_event: events[3],
        expected_event: expected_event_deposit_to_open_note,
        expected_event_selector: @selector!("OpenNoteDeposited"),
        expected_event_name: "OpenNoteDeposited",
    );

    // Try to apply the same action again.
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_deposit_swap() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    user.set_viewing_key_e2e();
    user.open_channel_with_token_e2e(recipient: user, :token_addr, outgoing_channel_index: 0);
    let token_out = test.new_token();
    let token_out_addr = token_out.contract_address();
    user.open_subchannel_e2e(recipient: user, token_addr: token_out_addr, index: 1);
    let create_open_note_input = user
        .new_open_note_with_generated_random(recipient: user, token_addr: token_out_addr, index: 0)
        .with_depositor(depositor: test.privacy.swap_executor.address);
    user.cheat_create_open_note(create_note_input: create_open_note_input);
    let deposit_input = DepositInput { token: token_addr, amount: 100 };
    let channel_key = user.compute_channel_key(recipient: user);
    let note_id = compute_note_id(
        :channel_key, token: token_out_addr, index: create_open_note_input.index,
    );
    let invoke_external_input = user
        .invoke_external_mock_swap_executor_input(
            in_token: token_addr, out_token: token_out_addr, amount: 100, :note_id,
        );
    let random = user.get_random();
    let withdraw_input = WithdrawInput {
        to_addr: test.privacy.swap_executor.address, token: token_addr, amount: 100, random,
    };
    let client_actions = [
        ClientAction::Deposit(deposit_input), ClientAction::Withdraw(withdraw_input),
        ClientAction::InvokeExternal(invoke_external_input),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
}

#[test]
fn test_internal_actions() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    user_2.set_viewing_key_e2e();

    // Set viewing key action.
    let (random, actions) = user_1.internal_set_viewing_key_with_generated_random();
    let enc_private_key = user_1.compute_enc_private_key(:random);
    let public_key_storage_path = map_entry_address(
        map_selector: selector!("public_key"), keys: [user_1.address.into()].span(),
    );
    let enc_private_key_storage_path = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [user_1.address.into()].span(),
    );
    let expected_actions = [
        to_write_once_action(storage_address: public_key_storage_path, value: user_1.public_key),
        to_write_once_action(storage_address: enc_private_key_storage_path, value: enc_private_key),
        ServerAction::EmitViewingKeySet(
            events::ViewingKeySet {
                user_addr: user_1.address, public_key: user_1.public_key, enc_private_key,
            },
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    user_1.set_viewing_key_e2e();

    // Open channel action.
    let (random_channel, salt_channel, actions) = user_1
        .internal_open_channel_with_generated_random_and_salt(recipient: user_2, index: 0);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random_channel,
        recipient_public_key: user_2.public_key,
        :channel_key,
        sender_addr: user_1.address,
    );
    let expected_channel_marker = user_1.compute_channel_marker(recipient: user_2);
    let channel_exists_storage_path = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [expected_channel_marker].span(),
    );
    let expected_outgoing_channel_id = user_1.compute_outgoing_channel_id(index: 0);
    let outgoing_channels_storage_path = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [expected_outgoing_channel_id].span(),
    );
    let expected_enc_outgoing_channel_info = user_1
        .compute_enc_outgoing_channel_info(recipient: user_2, index: 0, salt: salt_channel);
    let expected_actions = [
        ServerAction::Append(
            AppendInput {
                recipient_addr: user_2.address, enc_channel_info: expected_enc_channel_info,
            },
        ),
        to_write_once_action(storage_address: channel_exists_storage_path, value: true),
        to_write_once_action(
            storage_address: outgoing_channels_storage_path,
            value: expected_enc_outgoing_channel_info,
        ),
    ]
        .span();
    assert_eq!(actions, expected_actions);
    user_1.open_channel_e2e(recipient: user_2, index: 0);

    // Open subchannel action.
    let (salt_subchannel, actions) = user_1
        .internal_open_subchannel_with_generated_salt(recipient: user_2, :token_addr, index: 0);
    let subchannel_marker = user_1.compute_subchannel_marker(recipient: user_2, :token_addr);
    let subchannel_exists_storage_path = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [subchannel_marker].span(),
    );
    let subchannel_id = user_1.compute_subchannel_id(recipient: user_2, index: 0);
    let subchannel_tokens_storage_path = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [subchannel_id].span(),
    );
    let expected_enc_subchannel_info = user_1
        .compute_enc_subchannel_info(
            recipient: user_2, :token_addr, index: 0, salt: salt_subchannel,
        );
    let expected_actions = [
        to_write_once_action(
            storage_address: subchannel_tokens_storage_path, value: expected_enc_subchannel_info,
        ),
        to_write_once_action(storage_address: subchannel_exists_storage_path, value: true),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Create enc note action.
    let amount = 1;
    let index = 0;
    let subchannel_index = 0;
    let create_enc_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, :index);
    user_1.open_subchannel_e2e(recipient: user_2, :token_addr, index: subchannel_index);
    let actions = user_1.internal_create_enc_note(create_note_input: create_enc_note_input);
    assert_eq!(actions, create_enc_note_input.into_server_actions(user: user_1));

    // Create open note action.
    let mut create_open_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, :index);
    let actions = user_1.internal_create_open_note(create_note_input: create_open_note_input);
    assert_eq!(actions, create_open_note_input.into_server_actions(user: user_1));

    // Deposit action.
    let actions = user_1.internal_deposit(:token_addr, :amount);
    let expected_event = events::Deposit { user_addr: user_1.address, token: token_addr, amount };
    let expected_actions = [
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user_1.address, token: token_addr, amount: amount },
        ),
        ServerAction::EmitDeposit(expected_event),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Use (enc) note action.
    user_1.cheat_create_enc_note_e2e(create_note_input: create_enc_note_input);
    let nullifier = user_2.compute_nullifier(sender: user_1, :token_addr, :index);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput { channel_key, token: token_addr, index };
    let actions = user_2.internal_use_note(note: use_note_input);
    let storage_path_felt_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let expected_actions = [
        to_write_once_action(storage_address: storage_path_felt_nullifier, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier }),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Use open note.
    let index = 1;
    create_open_note_input.index = index;
    user_1
        .create_and_deposit_to_open_note_e2e(
            create_note_input: create_open_note_input, :amount, :token,
        );
    let nullifier = user_2.compute_nullifier(sender: user_1, :token_addr, :index);
    let use_open_note_input = UseNoteInput { channel_key, token: token_addr, index };
    let actions = user_2.internal_use_note(note: use_open_note_input);
    let storage_path_felt_open_nullifier = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let expected_actions = [
        to_write_once_action(storage_address: storage_path_felt_open_nullifier, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier }),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Withdraw action.
    let (random, actions) = user_2
        .internal_withdraw_with_generated_random(to_addr: user_1.address, :token_addr, :amount);
    let enc_user_addr = user_2.compute_enc_user_addr(:random);
    let expected_event = events::Withdrawal {
        enc_user_addr, to_addr: user_1.address, token: token_addr, amount,
    };
    let expected_actions = [
        ServerAction::TransferTo(
            TransferToInput { to_addr: user_1.address, token: token_addr, amount: amount },
        ),
        ServerAction::EmitWithdrawal(expected_event),
    ]
        .span();
    assert_eq!(actions, expected_actions);

    // Swap action.
    // Setup: create out_token, channel, and subchannel for it.
    let out_token = test.new_token();
    let out_token_addr = out_token.contract_address();
    let swap_amount: u128 = 50;
    // user_1 opens channel to self with subchannel for out_token (for swap output).
    user_1
        .open_channel_with_token_e2e(
            recipient: user_1, token_addr: out_token_addr, outgoing_channel_index: 1,
        );

    let channel_key_swap = user_1.compute_channel_key(recipient: user_1);
    let index: usize = 0;
    let note_id = compute_note_id(channel_key: channel_key_swap, token: out_token_addr, :index);

    let invoke_external_input = user_1
        .invoke_external_mock_swap_executor_input(
            in_token: token_addr, out_token: out_token_addr, amount: swap_amount, :note_id,
        );
    let actions = user_1.internal_invoke_external(input: invoke_external_input);

    // Expected: Invoke.
    let expected_actions = invoke_external_input.into_server_actions();
    assert_eq!(actions, expected_actions);
}

#[test]
fn test_validate_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();

    // Catch NON_ZERO_CALLER.
    let result = user.safe_validate(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_CALLER);

    // Catch INVALID_TX_VERSION.
    test.privacy.cheat_zero_caller_address();
    cheat_transaction_version(
        contract_address: user.privacy.address,
        version: Zero::zero(),
        span: CheatSpan::TargetCalls(1),
    );
    let result = user.safe_validate(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_TX_VERSION);

    // Catch NON_ZERO_TIP.
    test.privacy.cheat_zero_caller_address();
    cheat_tip(contract_address: user.privacy.address, tip: 1, span: CheatSpan::TargetCalls(1));
    let result = user.safe_validate(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_TIP);

    // Catch NON_ZERO_RESOURCE_PRICE.
    test.privacy.cheat_zero_caller_address();
    let result = user.safe_validate(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_RESOURCE_PRICE);
}

#[test]
fn test_execute_and_validate_accept_simulated_tx_version() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let random = user.get_random();
    let client_actions = [ClientAction::SetViewingKey(SetViewingKeyInput { random })].span();

    // Execute with simulated TX version.
    cheat_transaction_version(
        contract_address: test.privacy.address,
        version: ESTIMATION_BASE_TX_VERSION + TX_V3,
        span: CheatSpan::TargetCalls(1),
    );
    let server_actions = test
        .privacy
        .execute(user_addr: user.address, user_private_key: user.private_key, :client_actions);
    let expected_server_actions = user.set_viewing_key(:random);
    assert_eq!(server_actions, expected_server_actions);

    // Validate with simulated TX version.
    cheat_transaction_version(
        contract_address: test.privacy.address,
        version: ESTIMATION_BASE_TX_VERSION + TX_V3,
        span: CheatSpan::TargetCalls(1),
    );
    let result = test
        .privacy
        .validate(user_addr: user.address, user_private_key: user.private_key, :client_actions);
    assert_eq!(result, VALIDATED);
}

#[test]
fn test_execute_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();

    // Catch NON_ZERO_CALLER.
    let result = user.safe_execute_without_cheat(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_CALLER);

    // Catch INVALID_TX_VERSION.
    cheat_transaction_version(
        contract_address: user.privacy.address,
        version: Zero::zero(),
        span: CheatSpan::TargetCalls(1),
    );
    let result = user.safe_execute(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_TX_VERSION);

    // Catch EXPECTED_ONE_CALL (zero calls).
    let result = test.privacy.safe_execute_with_calls(calls: array![]);
    assert_panic_with_felt_error(:result, expected_error: errors::EXPECTED_ONE_CALL);

    // Catch EXPECTED_ONE_CALL (2 calls).
    let valid_call = *test
        .privacy
        .wrap_inputs_into_calls(
            user_addr: user.address, user_private_key: user.private_key, client_actions: [].span(),
        )[0];
    let result = test.privacy.safe_execute_with_calls(calls: array![valid_call, valid_call]);
    assert_panic_with_felt_error(:result, expected_error: errors::EXPECTED_ONE_CALL);

    // Catch INVALID_CALL_TO.
    let invalid_call = Call { to: user.address, ..valid_call };
    let result = test.privacy.safe_execute_with_calls(calls: array![invalid_call]);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CALL_TO);

    // Catch INVALID_CALL_SELECTOR.
    let invalid_call = Call { selector: selector!("invalid_selector"), ..valid_call };
    let result = test.privacy.safe_execute_with_calls(calls: array![invalid_call]);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CALL_SELECTOR);

    // Catch INVALID_CALLDATA.
    let invalid_call = Call { calldata: [0x0].span(), ..valid_call };
    let result = test.privacy.safe_execute_with_calls(calls: array![invalid_call]);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CALLDATA);

    // Catch INVALID_CALLDATA (trailing data after valid serialization).
    let mut calldata_with_trailing = array![];
    user.address.serialize(ref calldata_with_trailing);
    user.private_key.serialize(ref calldata_with_trailing);
    let empty_actions: Span<ClientAction> = [].span();
    empty_actions.serialize(ref calldata_with_trailing);
    calldata_with_trailing.append(1);
    let invalid_call = Call { calldata: calldata_with_trailing.span(), ..valid_call };
    let result = test.privacy.safe_execute_with_calls(calls: array![invalid_call]);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CALLDATA);

    // Catch INVALID_SIGNATURE.
    let mut user_invalid = test.new_user_with_is_valid(is_valid: false);
    let result = user_invalid
        .safe_execute(
            client_actions: [
                ClientAction::SetViewingKey(
                    SetViewingKeyInput { random: user_invalid.get_random() },
                ),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_SIGNATURE);
}

#[test]
fn test_compile_and_panic_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();

    // Catch ZERO_USER_ADDR.
    let mut user_zero_addr = user;
    user_zero_addr.address = Zero::zero();
    let result = user_zero_addr.safe_execute(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero_addr.safe_compile_and_panic(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);
    let result = user_zero_addr.safe_compile_actions(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_USER_ADDR);

    // Catch ZERO_PRIVATE_KEY.
    let mut user_zero_private_key = user;
    user_zero_private_key.private_key = Zero::zero();
    let result = user_zero_private_key.safe_execute(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_private_key.safe_compile_and_panic(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);
    let result = user_zero_private_key.safe_compile_actions(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PRIVATE_KEY);

    // Catch PRIVATE_KEY_NOT_CANONICAL.
    let mut user_private_key_not_canonical = user;
    user_private_key_not_canonical.private_key = Neg::neg(user.private_key);
    let result = user_private_key_not_canonical.safe_execute(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_private_key_not_canonical.safe_compile_and_panic(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);
    let result = user_private_key_not_canonical.safe_compile_actions(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::PRIVATE_KEY_NOT_CANONICAL);

    // Catch NO_REPLAY_PROTECTION.
    let result = user.safe_execute(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user.safe_compile_and_panic(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user.safe_compile_actions(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);

    // Catch ACTIONS_OUT_OF_ORDER. (just one sanity example, the other cases are tested in
    // test_actions_out_of_order).
    let token_addr = test.mock_new_token();
    let amount = 100;
    let random = user.get_random();
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::SetViewingKey(SetViewingKeyInput { random }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
}

#[test]
fn test_actions_out_of_order() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();

    let token_addr = test.mock_new_token();
    let amount = 100;
    user.set_viewing_key_e2e();
    let create_note_input_1 = user
        .new_enc_note_with_generated_salt(recipient: user, :token_addr, :amount, index: 0);
    let note_1_path = UseNoteInput {
        channel_key: user.compute_channel_key(recipient: user), token: token_addr, index: 0,
    };
    let create_note_input_2 = CreateEncNoteInput { index: 1, ..create_note_input_1 };

    // Catch NON_ZERO_VALUE (set viewing key twice).
    let random = user.get_random();
    let client_actions = [
        ClientAction::SetViewingKey(SetViewingKeyInput { random }),
        ClientAction::SetViewingKey(SetViewingKeyInput { random }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Catch ACTIONS_OUT_OF_ORDER (open channel -> set viewing key).
    let salt = user.get_salt().into();
    let client_actions = [
        ClientAction::OpenChannel(
            OpenChannelInput { recipient_addr: user.address, index: 0, random, salt },
        ),
        ClientAction::SetViewingKey(SetViewingKeyInput { random }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (open subchannel -> set viewing key).
    user.open_channel_e2e(recipient: user, index: 0);
    let channel_key = user.compute_channel_key(recipient: user);
    let salt = user.get_salt().into();
    let client_actions = [
        ClientAction::OpenSubchannel(
            OpenSubchannelInput {
                recipient_addr: user.address,
                recipient_public_key: user.public_key,
                channel_key,
                index: 0,
                token: token_addr,
                salt,
            },
        ),
        ClientAction::SetViewingKey(SetViewingKeyInput { random }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (open subchannel -> open channel).
    let client_actions = [
        ClientAction::OpenSubchannel(
            OpenSubchannelInput {
                recipient_addr: user.address,
                recipient_public_key: user.public_key,
                channel_key,
                index: 0,
                token: token_addr,
                salt,
            },
        ),
        ClientAction::OpenChannel(
            OpenChannelInput { recipient_addr: user.address, index: 0, random, salt },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (deposit -> set viewing key).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::SetViewingKey(SetViewingKeyInput { random }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (deposit -> open channel).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::OpenChannel(
            OpenChannelInput { recipient_addr: user.address, index: 0, random, salt },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (deposit -> open subchannel).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::OpenSubchannel(
            OpenSubchannelInput {
                recipient_addr: user.address,
                recipient_public_key: user.public_key,
                channel_key,
                index: 0,
                token: token_addr,
                salt,
            },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (use note -> set viewing key).
    user.open_subchannel_e2e(recipient: user, :token_addr, index: 0);
    user.cheat_create_enc_note_e2e(create_note_input: create_note_input_1);
    let client_actions = [
        ClientAction::UseNote(note_1_path),
        ClientAction::SetViewingKey(SetViewingKeyInput { random }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (use note -> open channel).
    let client_actions = [
        ClientAction::UseNote(note_1_path),
        ClientAction::OpenChannel(
            OpenChannelInput { recipient_addr: user.address, index: 0, random, salt },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (use note -> open subchannel).
    let client_actions = [
        ClientAction::UseNote(note_1_path),
        ClientAction::OpenSubchannel(
            OpenSubchannelInput {
                recipient_addr: user.address,
                recipient_public_key: user.public_key,
                channel_key,
                index: 0,
                token: token_addr,
                salt,
            },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (use note -> deposit).
    let client_actions = [
        ClientAction::UseNote(note_1_path),
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create enc note -> set viewing key).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::CreateEncNote(create_note_input_2),
        ClientAction::SetViewingKey(SetViewingKeyInput { random }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create enc note -> open channel).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::CreateEncNote(create_note_input_2),
        ClientAction::OpenChannel(
            OpenChannelInput { recipient_addr: user.address, index: 0, random, salt },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create enc note -> open subchannel).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::CreateEncNote(create_note_input_2),
        ClientAction::OpenSubchannel(
            OpenSubchannelInput {
                recipient_addr: user.address,
                recipient_public_key: user.public_key,
                channel_key,
                index: 0,
                token: token_addr,
                salt,
            },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create enc note -> deposit).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::CreateEncNote(create_note_input_2),
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create enc note -> use note).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::CreateEncNote(create_note_input_2), ClientAction::UseNote(note_1_path),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create open note -> set viewing key).
    let open_note = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, index: 1);
    let client_actions = [
        ClientAction::CreateOpenNote(open_note),
        ClientAction::SetViewingKey(SetViewingKeyInput { random }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create open note -> open channel).
    let client_actions = [
        ClientAction::CreateOpenNote(open_note),
        ClientAction::OpenChannel(
            OpenChannelInput { recipient_addr: user.address, index: 0, random, salt },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create open note -> open subchannel).
    let client_actions = [
        ClientAction::CreateOpenNote(open_note),
        ClientAction::OpenSubchannel(
            OpenSubchannelInput {
                recipient_addr: user.address,
                recipient_public_key: user.public_key,
                channel_key,
                index: 0,
                token: token_addr,
                salt,
            },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create open note -> deposit).
    let client_actions = [
        ClientAction::CreateOpenNote(open_note),
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (create open note -> use note).
    let client_actions = [
        ClientAction::CreateOpenNote(open_note), ClientAction::UseNote(note_1_path),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> set viewing key).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::Withdraw(
            WithdrawInput { to_addr: user.address, token: token_addr, amount, random },
        ),
        ClientAction::SetViewingKey(SetViewingKeyInput { random }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> open channel).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::Withdraw(
            WithdrawInput { to_addr: user.address, token: token_addr, amount, random },
        ),
        ClientAction::OpenChannel(
            OpenChannelInput { recipient_addr: user.address, index: 0, random, salt },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> open subchannel).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::Withdraw(
            WithdrawInput { to_addr: user.address, token: token_addr, amount, random },
        ),
        ClientAction::OpenSubchannel(
            OpenSubchannelInput {
                recipient_addr: user.address,
                recipient_public_key: user.public_key,
                channel_key,
                index: 0,
                token: token_addr,
                salt,
            },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> deposit).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::Withdraw(
            WithdrawInput { to_addr: user.address, token: token_addr, amount, random },
        ),
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> use note).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::Withdraw(
            WithdrawInput { to_addr: user.address, token: token_addr, amount, random },
        ),
        ClientAction::UseNote(note_1_path),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> create enc note).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::Withdraw(
            WithdrawInput { to_addr: user.address, token: token_addr, amount, random },
        ),
        ClientAction::CreateEncNote(create_note_input_2),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (withdraw -> create open note).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::Withdraw(
            WithdrawInput { to_addr: user.address, token: token_addr, amount, random },
        ),
        ClientAction::CreateOpenNote(open_note),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (invoke -> set viewing key).
    let out_token = test.new_token();
    let out_token_addr = out_token.contract_address();
    user.open_subchannel_e2e(recipient: user, token_addr: out_token_addr, index: 1);
    let note_id = compute_note_id(:channel_key, token: out_token_addr, index: open_note.index);
    let invoke_external_input = user
        .invoke_external_mock_swap_executor_input(
            in_token: token_addr, out_token: out_token_addr, :amount, :note_id,
        );
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::InvokeExternal(invoke_external_input),
        ClientAction::SetViewingKey(SetViewingKeyInput { random }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (invoke -> open channel).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::InvokeExternal(invoke_external_input),
        ClientAction::OpenChannel(
            OpenChannelInput { recipient_addr: user.address, index: 0, random, salt },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (invoke -> open subchannel).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::InvokeExternal(invoke_external_input),
        ClientAction::OpenSubchannel(
            OpenSubchannelInput {
                recipient_addr: user.address,
                recipient_public_key: user.public_key,
                channel_key,
                index: 0,
                token: token_addr,
                salt,
            },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (invoke -> deposit).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::InvokeExternal(invoke_external_input),
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (invoke -> use note).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::InvokeExternal(invoke_external_input), ClientAction::UseNote(note_1_path),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (invoke -> create enc note).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::InvokeExternal(invoke_external_input),
        ClientAction::CreateEncNote(create_note_input_2),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (invoke -> create open note).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::InvokeExternal(invoke_external_input),
        ClientAction::CreateOpenNote(open_note),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (invoke -> withdraw).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount }),
        ClientAction::InvokeExternal(invoke_external_input),
        ClientAction::Withdraw(
            WithdrawInput { to_addr: user.address, token: token_addr, amount, random },
        ),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);

    // Catch ACTIONS_OUT_OF_ORDER (invoke -> second invoke).
    let client_actions = [
        ClientAction::InvokeExternal(invoke_external_input),
        ClientAction::InvokeExternal(invoke_external_input),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
}

#[test]
fn test_compile_and_panic_balance_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();

    let token_addr = test.mock_new_token();
    let amount = 100;
    user.set_viewing_key_e2e();
    user.open_channel_with_token_e2e(recipient: user, :token_addr, outgoing_channel_index: 0);
    let create_note_input = user
        .new_enc_note_with_generated_salt(recipient: user, :token_addr, :amount, index: 0);
    user.cheat_create_enc_note_e2e(:create_note_input);
    let use_note_input = UseNoteInput {
        channel_key: user.compute_channel_key(recipient: user), token: token_addr, index: 0,
    };
    let create_note_input = CreateEncNoteInput { index: 1, ..create_note_input };

    // Catch FINAL_BALANCE_MUST_BE_ZERO (deposit).
    let client_actions = [
        ClientAction::Deposit(DepositInput { token: token_addr, amount: 2 * amount }),
        ClientAction::CreateEncNote(create_note_input),
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::FINAL_BALANCE_MUST_BE_ZERO);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::FINAL_BALANCE_MUST_BE_ZERO);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::FINAL_BALANCE_MUST_BE_ZERO);

    // Catch FINAL_BALANCE_MUST_BE_ZERO (use note).
    let client_actions = [ClientAction::UseNote(use_note_input)].span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::FINAL_BALANCE_MUST_BE_ZERO);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::FINAL_BALANCE_MUST_BE_ZERO);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::FINAL_BALANCE_MUST_BE_ZERO);

    // Catch NEGATIVE_INTERMEDIATE_BALANCE (withdraw).
    let random = user.get_random();
    let client_actions = [
        ClientAction::Withdraw(
            WithdrawInput { to_addr: user.address, token: token_addr, amount, random },
        )
    ]
        .span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);

    // Catch NEGATIVE_INTERMEDIATE_BALANCE (create note).
    let client_actions = [ClientAction::CreateEncNote(create_note_input),].span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);
}

#[test]
fn test_client_apply_writes() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = 100;
    let random = user.get_random();
    let salt = user.get_salt();
    let recipient_addr = user.address;
    let recipient_public_key = user.public_key;
    let channel_key = user.compute_channel_key(recipient: user);
    let index = 0;

    // Test SetViewingKey, OpenChannel, OpenSubchannel writes.
    let set_viewing_key = ClientAction::SetViewingKey(SetViewingKeyInput { random: random.into() });
    let open_channel = ClientAction::OpenChannel(
        OpenChannelInput { recipient_addr, index, random: random.into(), salt: salt.into() },
    );
    let open_subchannel = ClientAction::OpenSubchannel(
        OpenSubchannelInput {
            recipient_addr,
            recipient_public_key,
            channel_key,
            index,
            token: token_addr,
            salt: salt.into(),
        },
    );
    let deposit = ClientAction::Deposit(DepositInput { token: token_addr, amount });
    let create_enc_note_input = CreateEncNoteInput {
        recipient_addr, recipient_public_key, token: token_addr, amount, index, salt,
    };
    let create_enc_note = ClientAction::CreateEncNote(create_enc_note_input);
    let client_actions = [set_viewing_key, open_channel, open_subchannel, deposit, create_enc_note]
        .span();
    // Compile client actions.
    let mut spy_events = spy_events();
    let server_actions = user.execute(:client_actions);
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
    let channel_marker = user.compute_channel_marker(recipient: user);
    let channel_exists_storage_path = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [channel_marker].span(),
    );
    let enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random.into(), :recipient_public_key, :channel_key, sender_addr: address,
    );
    let outgoing_channel_id = user.compute_outgoing_channel_id(index: 0);
    let outgoing_channels_storage_path = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [outgoing_channel_id].span(),
    );
    let enc_outgoing_channel_info = user
        .compute_enc_outgoing_channel_info(recipient: user, :index, salt: salt.into());
    let subchannel_marker = user.compute_subchannel_marker(recipient: user, :token_addr);
    let subchannel_exists_storage_path = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [subchannel_marker].span(),
    );
    let subchannel_id = user.compute_subchannel_id(recipient: user, :index);
    let subchannel_tokens_storage_path = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [subchannel_id].span(),
    );
    let enc_subchannel_info = user
        .compute_enc_subchannel_info(recipient: user, :token_addr, index: 0, salt: salt.into());
    let expected_event_viewing_key_set = events::ViewingKeySet {
        user_addr: address, public_key, enc_private_key,
    };
    let expected_event_deposit = events::Deposit { user_addr: address, token: token_addr, amount };
    let mut expected_server_actions = array![
        // Set viewing key.
        to_write_once_action(storage_address: public_key_storage_path, value: public_key),
        to_write_once_action(storage_address: enc_private_key_storage_path, value: enc_private_key),
        ServerAction::EmitViewingKeySet(expected_event_viewing_key_set),
        // Open channel.
        ServerAction::Append(AppendInput { recipient_addr: address, enc_channel_info }),
        to_write_once_action(storage_address: channel_exists_storage_path, value: true),
        to_write_once_action(
            storage_address: outgoing_channels_storage_path, value: enc_outgoing_channel_info,
        ),
        // Open subchannel.
        to_write_once_action(
            storage_address: subchannel_tokens_storage_path, value: enc_subchannel_info,
        ),
        to_write_once_action(storage_address: subchannel_exists_storage_path, value: true),
        // Deposit.
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: address, token: token_addr, amount },
        ),
        ServerAction::EmitDeposit(expected_event_deposit),
    ];
    // Create note.
    expected_server_actions.append_span(create_enc_note_input.into_server_actions(:user));
    let expected_server_actions = expected_server_actions.span();
    // Assert server actions.
    assert_eq!(server_actions, expected_server_actions);
    let events = spy_events.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 0);
    // Assert view actions are the same.
    let view_actions = user.compile_actions(:client_actions);
    assert_eq!(view_actions, server_actions);
    // Test panic data matches the server actions.
    let panic_data_actions = user.compile_and_panic(:client_actions);
    assert_eq!(panic_data_actions, server_actions);

    // Test CreateEncNote writes.
    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());
    test.privacy.apply_actions(actions: server_actions);

    let create_note = ClientAction::CreateEncNote(
        CreateEncNoteInput {
            recipient_addr,
            recipient_public_key,
            token: token_addr,
            amount: amount / 2,
            index: index + 1,
            salt,
        },
    );
    let client_actions = [deposit, create_note, create_note].span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Test CreateOpenNote writes.
    let create_open_note_input = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, index: index + 1);
    let create_open_note = ClientAction::CreateOpenNote(create_open_note_input);
    let client_actions = [create_open_note, create_open_note].span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Test UseNote writes.
    let use_note = ClientAction::UseNote(
        UseNoteInput { channel_key, token: token_addr, index: index },
    );
    let result = user.safe_execute(client_actions: [use_note, use_note].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_client_transfers_dont_execute() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = 100;

    user.set_viewing_key_e2e();
    user.open_channel_e2e(recipient: user, index: 0);
    user.open_subchannel_e2e(recipient: user, :token_addr, index: 0);

    // Deposit.
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token.balance_of(address: user.address), Zero::zero());

    let salt = user.get_salt();
    let mut spy_events_deposit = spy_events();
    let server_actions = user
        .execute(
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_addr, amount }),
                ClientAction::CreateEncNote(
                    CreateEncNoteInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        token: token_addr,
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

    let create_note_input = CreateEncNoteInput {
        recipient_addr: user.address,
        recipient_public_key: user.public_key,
        token: token_addr,
        amount,
        index: 0,
        salt,
    };
    let expected_event = events::Deposit { user_addr: user.address, token: token_addr, amount };
    let mut expected_server_actions = array![
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user.address, token: token_addr, amount: amount.into() },
        ),
        ServerAction::EmitDeposit(expected_event),
    ];
    expected_server_actions.append_span(create_note_input.into_server_actions(:user));
    assert_eq!(server_actions, expected_server_actions.span());
    let result = test.privacy.safe_apply_actions(actions: server_actions);
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());

    // Execute deposit.
    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());

    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    test.privacy.apply_actions(actions: server_actions);

    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    // Withdraw.
    let random = user.get_random().into();
    let mut spy_events_withdraw = spy_events();
    let server_actions = user
        .execute(
            client_actions: [
                ClientAction::UseNote(
                    UseNoteInput {
                        channel_key: user.compute_channel_key(recipient: user),
                        token: token_addr,
                        index: 0,
                    },
                ),
                ClientAction::Withdraw(
                    WithdrawInput { to_addr: user.address, token: token_addr, amount, random },
                ),
            ]
                .span(),
        );

    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
    let events = spy_events_withdraw
        .get_events()
        .emitted_by(contract_address: test.privacy.address)
        .events;
    assert_eq!(events.len(), 0);

    let nullifier = user.compute_nullifier(sender: user, :token_addr, index: 0);
    let nullifier_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let enc_user_addr = user.compute_enc_user_addr(random: random.into());
    let expected_event = events::Withdrawal {
        enc_user_addr, to_addr: user.address, token: token_addr, amount,
    };
    let expected_server_actions = array![
        to_write_once_action(storage_address: nullifier_path, value: true),
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier }),
        ServerAction::TransferTo(
            TransferToInput { to_addr: user.address, token: token_addr, amount: amount.into() },
        ),
        ServerAction::EmitWithdrawal(expected_event),
    ]
        .span();
    assert_eq!(server_actions, expected_server_actions);

    test.privacy.apply_actions(actions: server_actions);
    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
}

#[test]
fn test_no_replay_protection() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = 100;

    user.set_viewing_key_e2e();
    user.open_channel_e2e(recipient: user, index: 0);
    user.open_subchannel_e2e(recipient: user, :token_addr, index: 0);

    // Empty client actions.
    let result = user.safe_execute(client_actions: [].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);

    // Deposit only.
    let deposit_action = ClientAction::Deposit(DepositInput { token: token_addr, amount });
    let result = user.safe_execute(client_actions: [deposit_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user.safe_compile_and_panic(client_actions: [deposit_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user.safe_compile_actions(client_actions: [deposit_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);

    // Withdraw only.
    let withdraw_action = ClientAction::Withdraw(
        WithdrawInput {
            to_addr: user.address, token: token_addr, amount, random: user.get_random(),
        },
    );
    let result = user.safe_execute(client_actions: [withdraw_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);
    let result = user.safe_compile_and_panic(client_actions: [withdraw_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);
    let result = user.safe_compile_actions(client_actions: [withdraw_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NEGATIVE_INTERMEDIATE_BALANCE);

    // InvokeExternal only.
    let out_token = test.new_token();
    let out_token_addr = out_token.contract_address();
    user.open_subchannel_e2e(recipient: user, token_addr: out_token_addr, index: 1);
    out_token.supply(address: test.privacy.mock_amm, :amount);
    let create_open_note_input = user
        .new_open_note_with_generated_random(recipient: user, token_addr: out_token_addr, index: 0);
    user.cheat_create_open_note(create_note_input: create_open_note_input);
    let channel_key = user.compute_channel_key(recipient: user);
    let note_id = compute_note_id(:channel_key, token: out_token_addr, index: 0);
    let invoke_action = ClientAction::InvokeExternal(
        user
            .invoke_external_mock_swap_executor_input(
                in_token: token_addr, out_token: out_token_addr, :amount, :note_id,
            ),
    );
    // InvokeExternal alone has should_execute=false, so no privacy actions.
    let result = user.safe_execute(client_actions: [invoke_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user.safe_compile_and_panic(client_actions: [invoke_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user.safe_compile_actions(client_actions: [invoke_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);

    // Deposit and Withdraw.
    let result = user.safe_execute(client_actions: [deposit_action, withdraw_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user
        .safe_compile_and_panic(client_actions: [deposit_action, withdraw_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user
        .safe_compile_actions(client_actions: [deposit_action, withdraw_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);

    // Deposit and InvokeExternal.
    let result = user.safe_execute(client_actions: [deposit_action, invoke_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user
        .safe_compile_and_panic(client_actions: [deposit_action, invoke_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user.safe_compile_actions(client_actions: [deposit_action, invoke_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);

    // Deposit, Withdraw, InvokeExternal.
    let deposit_action = ClientAction::Deposit(
        DepositInput { token: token_addr, amount: 2 * amount },
    );
    let result = user
        .safe_execute(client_actions: [deposit_action, withdraw_action, invoke_action].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user
        .safe_compile_and_panic(
            client_actions: [deposit_action, withdraw_action, invoke_action].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user
        .safe_compile_actions(
            client_actions: [deposit_action, withdraw_action, invoke_action].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
}

#[test]
fn test_execute_create_open_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = constants::DEFAULT_AMOUNT;
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    let index = 0;
    let random = user_1.get_random();
    let create_note_input = user_1
        .new_open_note(recipient: user_2, :token_addr, :index, :random)
        .with_depositor(depositor: test.privacy.echo_executor);

    // Pre-compute note_id and build the InvokeExternal for the echo executor.
    let (note_id, expected_note) = user_1
        .compute_open_note_with_amount(:create_note_input, :amount);
    let invoke_input = test
        .privacy
        .invoke_external_echo_deposits(
            [OpenNoteDeposit { note_id, token: token_addr, amount }].span(),
        );

    // Execute client actions.
    let client_actions = [
        ClientAction::CreateOpenNote(create_note_input), ClientAction::InvokeExternal(invoke_input),
    ]
        .span();
    let mut spy = spy_events();
    let actions = user_1.execute(:client_actions);

    // Compute expected values.
    assert_ne!(note_id, Zero::zero());
    let (stored_salt, stored_amount) = unpack(packed_value: expected_note.packed_value);
    assert_eq!(stored_salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, amount);
    assert_eq!(expected_note.token, token_addr);

    // Check the actions contain the create-note actions and the invoke action.
    let mut expected_actions = create_note_input.into_server_actions(user: user_1).into();
    expected_actions.append_span(invoke_input.into_server_actions());
    assert_eq!(actions, expected_actions.span());

    // Verify no events emitted.
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 0);

    // Verify view and panic paths return the same actions.
    let mut spy = spy_events();
    let view_actions = user_1.compile_actions(:client_actions);
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 0);
    assert_eq!(view_actions, actions);
    let mut spy = spy_events();
    let panic_data_actions = user_1.compile_and_panic(:client_actions);
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 0);
    assert_eq!(panic_data_actions, actions);

    // Verify storage before execution.
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    // Fund echo executor (depositor).
    token.supply(address: test.privacy.echo_executor, :amount);
    token
        .approve(
            owner: test.privacy.echo_executor, spender: test.privacy.address, amount: amount.into(),
        );

    // Execute actions and verify storage after.
    let mut spy = spy_events();
    test.privacy.apply_actions(:actions);
    assert_eq!(test.privacy.get_note(:note_id), expected_note);
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 2);
    let expected_event = events::OpenNoteCreated {
        enc_recipient_addr: user_2.compute_enc_user_addr(random: random.into()),
        depositor: create_note_input.depositor,
        token: token_addr,
        note_id,
    };
    assert_expected_event_emitted(
        spied_event: events[0],
        :expected_event,
        expected_event_selector: @selector!("OpenNoteCreated"),
        expected_event_name: "OpenNoteCreated",
    );
    // Assert that the other event was OpenNoteFilled.
    let expected_deposited_event = events::OpenNoteDeposited {
        depositor: test.privacy.echo_executor, token: token_addr, note_id, amount,
    };
    assert_expected_event_emitted(
        spied_event: events[1],
        expected_event: expected_deposited_event,
        expected_event_selector: @selector!("OpenNoteDeposited"),
        expected_event_name: "OpenNoteDeposited",
    );

    // Try to apply the same action again.
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}


#[test]
fn test_create_open_and_enc_notes_same_tx() {
    // Test that CreateOpenNote and CreateEncNote can be interleaved in the same transaction.
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = constants::DEFAULT_AMOUNT;
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);

    // Create 4 notes in order: open -> enc -> open -> enc.
    let open_0 = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0)
        .with_depositor(depositor: test.privacy.echo_executor);
    let enc_1 = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, amount: 0, index: 1);
    let open_2 = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 2)
        .with_depositor(depositor: test.privacy.echo_executor);
    let enc_3 = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, amount: 0, index: 3);

    // Pre-compute note IDs and expected deposited notes.
    let (open_id_0, expected_open_0) = user_1
        .compute_open_note_with_amount(create_note_input: open_0, :amount);
    let (open_id_2, expected_open_2) = user_1
        .compute_open_note_with_amount(create_note_input: open_2, :amount);

    // Fund echo executor (depositor) for both open notes.
    token.supply(address: test.privacy.echo_executor, amount: 2 * amount);
    token
        .approve(
            owner: test.privacy.echo_executor,
            spender: test.privacy.address,
            amount: (2 * amount).into(),
        );

    let invoke_input = test
        .privacy
        .invoke_external_echo_deposits(
            [
                OpenNoteDeposit { note_id: open_id_0, token: token_addr, amount },
                OpenNoteDeposit { note_id: open_id_2, token: token_addr, amount },
            ]
                .span(),
        );

    let actions = user_1
        .execute(
            [
                ClientAction::CreateOpenNote(open_0), ClientAction::CreateEncNote(enc_1),
                ClientAction::CreateOpenNote(open_2), ClientAction::CreateEncNote(enc_3),
                ClientAction::InvokeExternal(invoke_input),
            ]
                .span(),
        );
    test.privacy.apply_actions(:actions);

    // Verify enc notes via getter.
    let (enc_id_1, expected_enc_1) = user_1.compute_enc_note(create_note_input: enc_1);
    let (enc_id_3, expected_enc_3) = user_1.compute_enc_note(create_note_input: enc_3);
    assert_eq!(test.privacy.get_note(note_id: enc_id_1), expected_enc_1);
    assert_eq!(test.privacy.get_note(note_id: enc_id_3), expected_enc_3);

    // Verify open notes are deposited to.
    assert_eq!(test.privacy.get_note(note_id: open_id_0), expected_open_0);
    assert_eq!(test.privacy.get_note(note_id: open_id_2), expected_open_2);
}

#[test]
#[test_case(true, false)]
#[test_case(true, true)]
#[test_case(false, false)]
#[test_case(false, true)]
fn test_create_note_at_existing_note_id(initial_is_open: bool, colliding_is_open: bool) {
    // Test that creating a note at an existing note_id fails, even after the existing note is
    // spent.
    // Cases:
    // - (true, false): open note exists, try to create enc note
    // - (true, true): open note exists, try to create open note
    // - (false, false): enc note exists, try to create enc note
    // - (false, true): enc note exists, try to create open note
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = constants::DEFAULT_AMOUNT;
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_3.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_3, :token_addr, outgoing_channel_index: 0);

    // Create the possible create note inputs upfront.
    let open_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0);
    let enc_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, index: 0);
    let zero_enc_note_input = CreateEncNoteInput { amount: Zero::zero(), ..enc_note_input };

    // Create the initial note at index 0.
    if initial_is_open {
        user_1
            .create_and_deposit_to_open_note_e2e(
                create_note_input: open_note_input, :amount, :token,
            );
    } else {
        user_1.cheat_create_enc_note_e2e(create_note_input: enc_note_input);
    }

    // Try to create colliding note at same index - should fail.
    let result = if colliding_is_open {
        user_1.safe_create_open_note(create_note_input: open_note_input)
    } else {
        user_1.safe_create_enc_note(create_note_input: zero_enc_note_input)
    };
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Use the initial note.
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput { channel_key, token: token_addr, index: 0 };
    let transfer_note_input = user_2
        .new_enc_note_with_generated_salt(recipient: user_3, :token_addr, :amount, index: 0);
    let actions = user_2
        .transfer(
            notes_to_use: [use_note_input].span(), notes_to_create: [transfer_note_input].span(),
        );
    test.privacy.apply_actions(:actions);

    // Try again after using the note - should still fail.
    let result = if colliding_is_open {
        user_1.safe_create_open_note(create_note_input: open_note_input)
    } else {
        user_1.safe_create_enc_note(create_note_input: zero_enc_note_input)
    };
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
#[test_case(true, false)]
#[test_case(true, true)]
#[test_case(false, false)]
#[test_case(false, true)]
fn test_create_colliding_notes_in_same_tx(initial_is_open: bool, colliding_is_open: bool) {
    // Test that creating two notes with the same note_id in one tx fails.
    // Cases:
    // - (true, false): open note then enc note
    // - (true, true): open note then open note
    // - (false, false): enc note then enc note
    // - (false, true): enc note then open note
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);

    let open_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0);
    let enc_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, amount: 0, index: 0);
    let mut client_actions: Array<ClientAction> = array![];
    client_actions
        .append(
            if initial_is_open {
                ClientAction::CreateOpenNote(open_note_input)
            } else {
                ClientAction::CreateEncNote(enc_note_input)
            },
        );
    client_actions
        .append(
            if colliding_is_open {
                ClientAction::CreateOpenNote(open_note_input)
            } else {
                ClientAction::CreateEncNote(enc_note_input)
            },
        );
    let client_actions = client_actions.span();

    let result = user_1.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user_1.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
    let result = user_1.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    let (open_note_id, _) = user_1.compute_open_note(create_note_input: open_note_input);
    let (enc_note_id, _) = user_1.compute_enc_note(create_note_input: enc_note_input);
    assert_eq!(open_note_id, enc_note_id);
    assert_eq!(test.privacy.get_note(note_id: open_note_id), Zero::zero());
}

#[test]
fn test_deposit_to_open_note_twice() {
    // Test that depositing to an already-deposited open note fails with NOTE_ALREADY_DEPOSITED.
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = constants::DEFAULT_AMOUNT;
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_3.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    user_2.open_channel_with_token_e2e(recipient: user_3, :token_addr, outgoing_channel_index: 0);

    // TX 1: Create and deposit to open note A in the same transaction.
    let create_note_input_a = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0);
    let note_id_a = user_1
        .create_and_deposit_to_open_note_e2e(
            create_note_input: create_note_input_a, :amount, :token,
        );

    // TX 2: Attempt to deposit into the already-deposited note A.
    let deposit = OpenNoteDeposit { note_id: note_id_a, token: token_addr, amount };
    let bad_deposit = test
        .privacy
        .invoke_external_echo_deposits([deposit].span())
        .into_server_actions();
    let result = test.privacy.safe_apply_actions(actions: bad_deposit);
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_ALREADY_DEPOSITED);

    // Use the deposited note A: spend it.
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note = UseNoteInput { channel_key, token: token_addr, index: 0 };
    let new_note = user_2
        .new_enc_note_with_generated_salt(recipient: user_3, :token_addr, :amount, index: 0);
    let transfer_actions = user_2
        .transfer(notes_to_use: [use_note].span(), notes_to_create: [new_note].span());
    test.privacy.apply_actions(actions: transfer_actions);

    // Verify nullifier was created.
    let nullifier = user_2.compute_nullifier(sender: user_1, :token_addr, index: 0);
    assert!(test.privacy.nullifier_exists(:nullifier));

    // Try to deposit again after using the note - should still fail with NOTE_ALREADY_DEPOSITED.
    let result = test.privacy.safe_apply_actions(actions: bad_deposit);
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_ALREADY_DEPOSITED);
}

#[test]
fn test_use_deposited_open_note_twice_single_tx() {
    // Test that using the same deposited open note twice in a single transaction fails.
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = constants::DEFAULT_AMOUNT;
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);

    // Create an open note.
    let index = 0;
    let create_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, :index);
    user_1.create_and_deposit_to_open_note_e2e(:create_note_input, :amount, :token);

    // Try to use the same open note twice in a single transaction - should fail.
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput { channel_key, token: token_addr, index };
    let use_note_action = ClientAction::UseNote(use_note_input);
    let client_actions = [use_note_action, use_note_action].span();
    let result = user_2.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_swap_client_action() {
    let mut test: Test = Default::default();
    let in_token = test.new_token();
    let out_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let in_token_addr = in_token.contract_address();
    let out_token_addr = out_token.contract_address();
    let amm_address = test.privacy.mock_amm;
    let swap_executor_addr = test.privacy.swap_executor.address;

    // Setup user.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();

    // Open channel and subchannel for input token (for deposit).
    user
        .open_channel_with_token_e2e(
            recipient: user, token_addr: in_token_addr, outgoing_channel_index: 0,
        );

    // Open subchannel for output token (for open note).
    user.open_subchannel_e2e(recipient: user, token_addr: out_token_addr, index: 1);

    // Fund AMM with output tokens.
    out_token.supply(address: amm_address, amount: swap_amount);

    // === Setup: Create encrypted note with deposited funds and open note for swap output ===

    // Create enc note for the input tokens (fund user and cheat deposit it directly).
    let create_enc_note_input = user
        .new_enc_note_with_generated_salt(
            recipient: user, token_addr: in_token_addr, amount: swap_amount, index: 0,
        );
    user.increase_token_balance(token: in_token, amount: swap_amount);
    user
        .cheat_deposit(
            token: in_token, amount: swap_amount, create_note_input: create_enc_note_input,
        );

    // Create an open note for the swap output.
    let create_open_note_input = user
        .new_open_note_with_generated_random(recipient: user, token_addr: out_token_addr, index: 0)
        .with_depositor(depositor: swap_executor_addr);
    let (open_note_id, _) = user.compute_open_note(create_note_input: create_open_note_input);

    // === Verify balances before swap ===
    // Privacy contract: has in_token (deposited), no out_token.
    assert_eq!(in_token.balance_of(address: test.privacy.address), swap_amount.into());
    assert_eq!(out_token.balance_of(address: test.privacy.address), 0);
    // Swap executor: no tokens.
    assert_eq!(in_token.balance_of(address: swap_executor_addr), 0);
    assert_eq!(out_token.balance_of(address: swap_executor_addr), 0);
    // AMM: no in_token, has out_token.
    assert_eq!(in_token.balance_of(address: amm_address), 0);
    assert_eq!(out_token.balance_of(address: amm_address), swap_amount.into());

    // === Execute: Use the deposited note and swap ===

    // Create use note input for the deposited input tokens.
    let channel_key = user.compute_channel_key(recipient: user);
    let use_note_input = UseNoteInput { channel_key, token: in_token_addr, index: 0 };

    // Create invoke external input for the swap executor.
    let out_channel_key = user.compute_channel_key(recipient: user);
    let note_id = compute_note_id(channel_key: out_channel_key, token: out_token_addr, index: 0);
    let invoke_external_input = user
        .invoke_external_mock_swap_executor_input(
            in_token: in_token_addr, out_token: out_token_addr, amount: swap_amount, :note_id,
        );

    // Create withdraw input to transfer input tokens to swap executor.
    let random = user.get_random();
    let withdraw_input = WithdrawInput {
        to_addr: swap_executor_addr, token: in_token_addr, amount: swap_amount, random,
    };

    // Execute: UseNote -> CreateOpenNote -> Withdraw -> InvokeExternal.
    // UseNote: uses the encrypted note containing input tokens.
    // CreateOpenNote: creates the open note for swap output.
    // Withdraw: transfers input tokens to swap executor.
    // InvokeExternal: invokes swap executor, deposits output to open note.
    let client_actions = [
        ClientAction::UseNote(use_note_input), ClientAction::CreateOpenNote(create_open_note_input),
        ClientAction::Withdraw(withdraw_input), ClientAction::InvokeExternal(invoke_external_input),
    ]
        .span();
    let server_actions = user.execute(:client_actions);

    // Spy on events before executing.
    let mut spy = spy_events();
    test.privacy.apply_actions(actions: server_actions);

    // === Verify balances after swap ===
    // Privacy contract: no in_token (swapped), has out_token (received).
    assert_eq!(in_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(out_token.balance_of(address: test.privacy.address), swap_amount.into());
    // Swap executor: no tokens (passed through).
    assert_eq!(in_token.balance_of(address: swap_executor_addr), 0);
    assert_eq!(out_token.balance_of(address: swap_executor_addr), 0);
    // AMM: has in_token (received), no out_token (sent).
    assert_eq!(in_token.balance_of(address: amm_address), swap_amount.into());
    assert_eq!(out_token.balance_of(address: amm_address), 0);

    // Verify the open note was deposited to with swap output.
    let deposited_note = test.privacy.get_note(note_id: open_note_id);
    let (salt, deposited_amount) = unpack(packed_value: deposited_note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(deposited_amount, swap_amount);

    // Verify events were properly emitted.
    let emitted_events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(emitted_events.len(), 4);

    // Verify NoteUsed event (nullifier recorded).
    let nullifier = user.compute_nullifier(sender: user, token_addr: in_token_addr, index: 0);
    assert_expected_event_emitted(
        spied_event: emitted_events[0],
        expected_event: events::NoteUsed { nullifier },
        expected_event_selector: @selector!("NoteUsed"),
        expected_event_name: "NoteUsed",
    );

    // Verify OpenNoteCreated event (open note created for swap output).
    let enc_recipient_addr = encrypt_user_addr(
        ephemeral_secret: create_open_note_input.random,
        auditor_public_key: test.privacy.get_auditor_public_key(),
        user_addr: user.address,
    );
    let expected_create_event = events::OpenNoteCreated {
        enc_recipient_addr,
        depositor: create_open_note_input.depositor,
        token: out_token_addr,
        note_id: open_note_id,
    };
    assert_expected_event_emitted(
        spied_event: emitted_events[1],
        expected_event: expected_create_event,
        expected_event_selector: @selector!("OpenNoteCreated"),
        expected_event_name: "OpenNoteCreated",
    );

    // Verify Withdrawal event (input tokens transferred to swap executor).
    let expected_withdrawal_event = events::Withdrawal {
        enc_user_addr: encrypt_user_addr(
            ephemeral_secret: random,
            auditor_public_key: test.privacy.get_auditor_public_key(),
            user_addr: user.address,
        ),
        to_addr: swap_executor_addr,
        token: in_token_addr,
        amount: swap_amount,
    };
    assert_expected_event_emitted(
        spied_event: emitted_events[2],
        expected_event: expected_withdrawal_event,
        expected_event_selector: @selector!("Withdrawal"),
        expected_event_name: "Withdrawal",
    );

    // Verify OpenNoteDeposited event (output tokens deposited to open note).
    let expected_deposit_event = events::OpenNoteDeposited {
        depositor: swap_executor_addr,
        token: out_token_addr,
        note_id: open_note_id,
        amount: swap_amount,
    };
    assert_expected_event_emitted(
        spied_event: emitted_events[3],
        expected_event: expected_deposit_event,
        expected_event_selector: @selector!("OpenNoteDeposited"),
        expected_event_name: "OpenNoteDeposited",
    );
}

#[test]
fn test_swap_without_withdraw_fails() {
    // Verify that applying an Invoke server action without a prior withdraw fails
    // because the swap executor doesn't have the input tokens.
    let mut test: Test = Default::default();
    let in_token = test.new_token();
    let out_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let in_token_addr = in_token.contract_address();
    let out_token_addr = out_token.contract_address();

    // Setup user.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();

    // Open channel and subchannel for output token.
    user
        .open_channel_with_token_e2e(
            recipient: user, token_addr: out_token_addr, outgoing_channel_index: 0,
        );

    // Fund AMM with output tokens.
    out_token.supply(address: test.privacy.mock_amm, amount: swap_amount);

    // Create open note for swap output.
    let create_open_note_input = user
        .new_open_note_with_generated_random(recipient: user, token_addr: out_token_addr, index: 0);
    let channel_key = user.compute_channel_key(recipient: user);
    let note_id = compute_note_id(:channel_key, token: out_token_addr, index: 0);
    let invoke_external_input = user
        .invoke_external_mock_swap_executor_input(
            in_token: in_token_addr, out_token: out_token_addr, amount: swap_amount, :note_id,
        );
    let server_actions = user
        .execute(
            client_actions: [
                ClientAction::CreateOpenNote(create_open_note_input),
                ClientAction::InvokeExternal(invoke_external_input),
            ]
                .span(),
        );
    let mut expected_server_actions: Array<ServerAction> = create_open_note_input
        .into_server_actions(:user)
        .into();
    expected_server_actions.append(invoke_external_input.into_server_action());
    assert_eq!(server_actions, expected_server_actions.span());
    let result = test.privacy.safe_apply_actions(actions: server_actions);
    assert_panic_with_felt_error(
        :result, expected_error: mock_swap_executor_errors::INSUFFICIENT_BALANCE,
    );
}

#[test]
fn test_multiple_invoke_external_reverts() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();

    let dummy_invoke = InvokeExternalInput {
        contract_address: test.privacy.swap_executor.address, calldata: [].span(),
    };
    let client_actions = [
        ClientAction::InvokeExternal(dummy_invoke), ClientAction::InvokeExternal(dummy_invoke),
    ]
        .span();

    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ACTIONS_OUT_OF_ORDER);
}

#[test]
fn test_invoke_external_client_action_assertions() {
    // Test InvokeExternal validation errors.
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();
    user.open_channel_with_token_e2e(recipient: user, :token_addr, outgoing_channel_index: 0);

    // Catch ZERO_CONTRACT_ADDRESS.
    let input = InvokeExternalInput { contract_address: Zero::zero(), calldata: [].span() };
    let client_actions = [ClientAction::InvokeExternal(input)].span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_CONTRACT_ADDRESS);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_CONTRACT_ADDRESS);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_CONTRACT_ADDRESS);

    // InvokeExternal alone (no privacy actions) - has should_execute=false, so without a
    // privacy action like UseNote, the transaction fails.
    let valid_input = InvokeExternalInput {
        contract_address: test.privacy.swap_executor.address, calldata: [].span(),
    };
    let client_actions = [ClientAction::InvokeExternal(valid_input)].span();
    let result = user.safe_execute(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user.safe_compile_and_panic(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
    let result = user.safe_compile_actions(:client_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NO_REPLAY_PROTECTION);
}

#[test]
fn test_invoke_external_swap_deposit_errors() {
    // Test swap errors that occur during server action execution (deposit-related).
    // These tests use the server action execution to catch errors that happen when
    // the swap tries to deposit into the output note.
    let mut test: Test = Default::default();
    let in_token = test.new_token();
    let out_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let in_token_addr = in_token.contract_address();
    let out_token_addr = out_token.contract_address();
    let amm_address = test.privacy.mock_amm;
    let swap_executor_addr = test.privacy.swap_executor.address;

    // Setup user.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();

    // Open channel and subchannel for input token (for deposit).
    user
        .open_channel_with_token_e2e(
            recipient: user, token_addr: in_token_addr, outgoing_channel_index: 0,
        );

    // Open subchannel for output token (for open note).
    user.open_subchannel_e2e(recipient: user, token_addr: out_token_addr, index: 1);

    // Fund swap executor with input tokens (enough for multiple attempts).
    in_token.supply(address: swap_executor_addr, amount: swap_amount * 4);

    // Fund AMM with output tokens (enough for multiple swaps).
    out_token.supply(address: amm_address, amount: swap_amount * 4);

    let channel_key = user.compute_channel_key(recipient: user);

    // === Test NOTE_NOT_FOUND ===
    // Create enc note for input tokens at index 0.
    let create_enc_note_input_0 = user
        .new_enc_note_with_generated_salt(
            recipient: user, token_addr: in_token_addr, amount: swap_amount, index: 0,
        );
    user.increase_token_balance(token: in_token, amount: swap_amount);
    user
        .cheat_deposit(
            token: in_token, amount: swap_amount, create_note_input: create_enc_note_input_0,
        );
    let use_note_input_0 = UseNoteInput { channel_key, token: in_token_addr, index: 0 };

    // Try to swap to a note that doesn't exist (subchannel exists at index 1, but no note
    // created).
    let note_id = compute_note_id(:channel_key, token: out_token_addr, index: 0);
    let invoke_external_input = user
        .invoke_external_mock_swap_executor_input(
            in_token: in_token_addr, out_token: out_token_addr, amount: swap_amount, :note_id,
        );
    let random = user.get_random();
    let withdraw_input = WithdrawInput {
        to_addr: swap_executor_addr, token: in_token_addr, amount: swap_amount, random,
    };
    let client_actions = [
        ClientAction::UseNote(use_note_input_0), ClientAction::Withdraw(withdraw_input),
        ClientAction::InvokeExternal(invoke_external_input),
    ]
        .span();
    let server_actions = user.execute(:client_actions);
    let result = test.privacy.safe_apply_actions(actions: server_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    // === Test NOTE_NOT_OPEN ===
    // Create a new enc note at index 1 for input tokens (note 0 was used in failed tx above).
    let create_enc_note_input_1 = user
        .new_enc_note_with_generated_salt(
            recipient: user, token_addr: in_token_addr, amount: swap_amount, index: 1,
        );
    user.increase_token_balance(token: in_token, amount: swap_amount);
    user
        .cheat_deposit(
            token: in_token, amount: swap_amount, create_note_input: create_enc_note_input_1,
        );
    let use_note_input_1 = UseNoteInput { channel_key, token: in_token_addr, index: 1 };

    // Create an enc note (not open) for output token to try depositing into.
    let create_enc_note_out = user
        .new_enc_note_with_generated_salt(
            recipient: user, token_addr: out_token_addr, amount: swap_amount, index: 0,
        );
    user.cheat_create_enc_note_e2e(create_note_input: create_enc_note_out);

    let client_actions = [
        ClientAction::UseNote(use_note_input_1), ClientAction::Withdraw(withdraw_input),
        ClientAction::InvokeExternal(invoke_external_input),
    ]
        .span();
    let server_actions = user.execute(:client_actions);
    let result = test.privacy.safe_apply_actions(actions: server_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_OPEN);

    // === Test NOTE_ALREADY_DEPOSITED ===
    // Create a new enc note at index 2 for input tokens.
    let create_enc_note_input_2 = user
        .new_enc_note_with_generated_salt(
            recipient: user, token_addr: in_token_addr, amount: swap_amount, index: 2,
        );
    user.increase_token_balance(token: in_token, amount: swap_amount);
    user
        .cheat_deposit(
            token: in_token, amount: swap_amount, create_note_input: create_enc_note_input_2,
        );
    let use_note_input_2 = UseNoteInput { channel_key, token: in_token_addr, index: 2 };

    // Create an open note for the swap output.
    let create_open_note_input = user
        .new_open_note_with_generated_random(recipient: user, token_addr: out_token_addr, index: 1)
        .with_depositor(depositor: swap_executor_addr);

    let note_id = compute_note_id(:channel_key, token: out_token_addr, index: 1);
    let invoke_external_input_1 = user
        .invoke_external_mock_swap_executor_input(
            in_token: in_token_addr, out_token: out_token_addr, amount: swap_amount, :note_id,
        );

    // First swap succeeds — include CreateOpenNote so the create count matches the deposit.
    let client_actions = [
        ClientAction::UseNote(use_note_input_2),
        ClientAction::CreateOpenNote(create_open_note_input),
        ClientAction::Withdraw(withdraw_input),
        ClientAction::InvokeExternal(invoke_external_input_1),
    ]
        .span();
    let server_actions = user.execute(:client_actions);
    test.privacy.apply_actions(actions: server_actions);

    // Create another enc note at index 3 for input tokens.
    let create_enc_note_input_3 = user
        .new_enc_note_with_generated_salt(
            recipient: user, token_addr: in_token_addr, amount: swap_amount, index: 3,
        );
    user.increase_token_balance(token: in_token, amount: swap_amount);
    user
        .cheat_deposit(
            token: in_token, amount: swap_amount, create_note_input: create_enc_note_input_3,
        );
    let use_note_input_3 = UseNoteInput { channel_key, token: in_token_addr, index: 3 };

    // Second swap to same note should fail.
    let client_actions = [
        ClientAction::UseNote(use_note_input_3), ClientAction::Withdraw(withdraw_input),
        ClientAction::InvokeExternal(invoke_external_input_1),
    ]
        .span();
    let server_actions = user.execute(:client_actions);
    let result = test.privacy.safe_apply_actions(actions: server_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_ALREADY_DEPOSITED);

    // === Test TOKEN_MISMATCH ===
    // Create an open note for the *input* token; swap executor will try to deposit *output*
    // token into it, triggering TOKEN_MISMATCH.
    let create_enc_note_input_5 = user
        .new_enc_note_with_generated_salt(
            recipient: user, token_addr: in_token_addr, amount: swap_amount, index: 5,
        );
    user.increase_token_balance(token: in_token, amount: swap_amount);
    user
        .cheat_deposit(
            token: in_token, amount: swap_amount, create_note_input: create_enc_note_input_5,
        );
    let use_note_input_5 = UseNoteInput { channel_key, token: in_token_addr, index: 5 };

    let create_open_note_input_token_mismatch = user
        .new_open_note_with_generated_random(recipient: user, token_addr: in_token_addr, index: 6)
        .with_depositor(depositor: swap_executor_addr);
    user.cheat_create_open_note(create_note_input: create_open_note_input_token_mismatch);

    let note_id = compute_note_id(:channel_key, token: in_token_addr, index: 6);
    let invoke_external_input_token_mismatch = user
        .invoke_external_mock_swap_executor_input(
            in_token: in_token_addr, out_token: out_token_addr, amount: swap_amount, :note_id,
        );
    let client_actions = [
        ClientAction::UseNote(use_note_input_5), ClientAction::Withdraw(withdraw_input),
        ClientAction::InvokeExternal(invoke_external_input_token_mismatch),
    ]
        .span();
    let server_actions = user.execute(:client_actions);
    let result = test.privacy.safe_apply_actions(actions: server_actions);
    assert_panic_with_felt_error(:result, expected_error: errors::TOKEN_MISMATCH);
}

#[test]
fn test_invoke_doesnt_execute_during_execute() {
    // Verify that InvokeExternal doesn't actually invoke the target during execute().
    // We pass a dummy contract address that would fail if called, paired with a valid privacy
    // action. If execute() succeeds, it proves the invoke was deferred to apply_actions.
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let random = user.get_random();

    let dummy_contract: ContractAddress = 'DUMMY_CONTRACT'.try_into().unwrap();
    let invoke_external_input = InvokeExternalInput {
        contract_address: dummy_contract, calldata: [1, 2, 3].span(),
    };
    let client_actions = [
        ClientAction::SetViewingKey(SetViewingKeyInput { random }),
        ClientAction::InvokeExternal(invoke_external_input),
    ]
        .span();

    // execute() succeeds -- proving the invoke was not actually called.
    user.execute(:client_actions);
}

#[test]
fn test_invoke_external_swap_doesnt_execute_during_execute() {
    let mut test: Test = Default::default();
    let in_token = test.new_token();
    let out_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let in_token_addr = in_token.contract_address();
    let out_token_addr = out_token.contract_address();
    let amm_address = test.privacy.mock_amm;
    let swap_executor_addr = test.privacy.swap_executor.address;

    // Setup user with viewing key, channels, and subchannels.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    user
        .open_channel_with_token_e2e(
            recipient: user, token_addr: in_token_addr, outgoing_channel_index: 0,
        );
    user.open_subchannel_e2e(recipient: user, token_addr: out_token_addr, index: 1);

    // Fund AMM with output tokens.
    out_token.supply(address: amm_address, amount: swap_amount);

    // Create enc note with input tokens (via cheat_deposit).
    let create_enc_note_input = user
        .new_enc_note_with_generated_salt(
            recipient: user, token_addr: in_token_addr, amount: swap_amount, index: 0,
        );
    user.increase_token_balance(token: in_token, amount: swap_amount);
    user
        .cheat_deposit(
            token: in_token, amount: swap_amount, create_note_input: create_enc_note_input,
        );

    // Create open note for swap output.
    let create_open_note_input = user
        .new_open_note_with_generated_random(recipient: user, token_addr: out_token_addr, index: 0)
        .with_depositor(depositor: swap_executor_addr);
    let (open_note_id, _) = user.compute_open_note(create_note_input: create_open_note_input);

    // === Verify balances BEFORE everything ===
    // Privacy contract: has in_token (deposited), no out_token.
    assert_eq!(in_token.balance_of(address: test.privacy.address), swap_amount.into());
    assert_eq!(out_token.balance_of(address: test.privacy.address), 0);
    // Swap executor: no tokens.
    assert_eq!(in_token.balance_of(address: swap_executor_addr), 0);
    assert_eq!(out_token.balance_of(address: swap_executor_addr), 0);
    // AMM: no in_token, has out_token.
    assert_eq!(in_token.balance_of(address: amm_address), 0);
    assert_eq!(out_token.balance_of(address: amm_address), swap_amount.into());

    // Prepare swap and withdraw inputs.
    let channel_key = user.compute_channel_key(recipient: user);
    let use_note_input = UseNoteInput { channel_key, token: in_token_addr, index: 0 };
    let note_id = compute_note_id(:channel_key, token: out_token_addr, index: 0);
    let invoke_external_input = user
        .invoke_external_mock_swap_executor_input(
            in_token: in_token_addr, out_token: out_token_addr, amount: swap_amount, :note_id,
        );
    let random = user.get_random();
    let withdraw_input = WithdrawInput {
        to_addr: swap_executor_addr, token: in_token_addr, amount: swap_amount, random,
    };

    // Execute execute (should NOT transfer or swap).
    let mut spy = spy_events();
    let client_actions = [
        ClientAction::UseNote(use_note_input), ClientAction::CreateOpenNote(create_open_note_input),
        ClientAction::Withdraw(withdraw_input), ClientAction::InvokeExternal(invoke_external_input),
    ]
        .span();
    let server_actions = user.execute(:client_actions);
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    // === Verify balances BETWEEN execute and apply_actions ===
    // All balances should be unchanged - no transfers or swap executed during execute.
    // Privacy contract: still has in_token, no out_token.
    assert_eq!(in_token.balance_of(address: test.privacy.address), swap_amount.into());
    assert_eq!(out_token.balance_of(address: test.privacy.address), 0);
    // Swap executor: still no tokens.
    assert_eq!(in_token.balance_of(address: swap_executor_addr), 0);
    assert_eq!(out_token.balance_of(address: swap_executor_addr), 0);
    // AMM: still no in_token, still has out_token.
    assert_eq!(in_token.balance_of(address: amm_address), 0);
    assert_eq!(out_token.balance_of(address: amm_address), swap_amount.into());

    let events_during_execute = spy
        .get_events()
        .emitted_by(contract_address: test.privacy.address)
        .events;
    assert_eq!(events_during_execute.len(), 0);

    // Assert expected server actions were generated.
    let nullifier = user.compute_nullifier(sender: user, token_addr: in_token_addr, index: 0);
    let nullifier_path = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let enc_user_addr = user.compute_enc_user_addr(:random);
    let expected_withdrawal_event = events::Withdrawal {
        enc_user_addr, to_addr: swap_executor_addr, token: in_token_addr, amount: swap_amount,
    };
    let create_open_note_actions = create_open_note_input.into_server_actions(:user);
    let mut expected_server_actions: Array<ServerAction> = array![
        // UseNote: write nullifier.
        to_write_once_action(storage_address: nullifier_path, value: true),
        // UseNote: emit NoteUsed.
        ServerAction::EmitNoteUsed(events::NoteUsed { nullifier }),
    ];
    // CreateOpenNote: WriteOnce + EmitOpenNoteCreated.
    expected_server_actions.append_span(create_open_note_actions);
    // Withdraw: TransferTo (input tokens to swap executor).
    expected_server_actions
        .append(
            ServerAction::TransferTo(
                TransferToInput {
                    to_addr: swap_executor_addr, token: in_token_addr, amount: swap_amount,
                },
            ),
        );
    // Withdraw: EmitWithdrawal.
    expected_server_actions.append(ServerAction::EmitWithdrawal(expected_withdrawal_event));
    expected_server_actions
        .append(
            user
                .invoke_external_mock_swap_executor_input(
                    in_token: in_token_addr,
                    out_token: out_token_addr,
                    amount: swap_amount,
                    :note_id,
                )
                .into_server_action(),
        );
    assert_eq!(server_actions, expected_server_actions.span());

    // Now execute server actions.
    let mut spy_after = spy_events();
    test.privacy.apply_actions(actions: server_actions);

    // === Verify balances AFTER apply_actions ===
    // Privacy contract: no in_token (swapped), has out_token (received).
    assert_eq!(in_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(out_token.balance_of(address: test.privacy.address), swap_amount.into());
    // Swap executor: no tokens (passed through).
    assert_eq!(in_token.balance_of(address: swap_executor_addr), 0);
    assert_eq!(out_token.balance_of(address: swap_executor_addr), 0);
    // AMM: has in_token (received), no out_token (sent).
    assert_eq!(in_token.balance_of(address: amm_address), swap_amount.into());
    assert_eq!(out_token.balance_of(address: amm_address), 0);

    // Assert events emitted after apply_actions.
    let events_after = spy_after
        .get_events()
        .emitted_by(contract_address: test.privacy.address)
        .events;
    assert_eq!(events_after.len(), 4);
    assert_expected_event_emitted(
        spied_event: events_after[0],
        expected_event: events::NoteUsed { nullifier },
        expected_event_selector: @selector!("NoteUsed"),
        expected_event_name: "NoteUsed",
    );
    let enc_recipient_addr = encrypt_user_addr(
        ephemeral_secret: create_open_note_input.random,
        auditor_public_key: test.privacy.get_auditor_public_key(),
        user_addr: user.address,
    );
    let expected_create_event = events::OpenNoteCreated {
        enc_recipient_addr,
        depositor: create_open_note_input.depositor,
        token: out_token_addr,
        note_id: open_note_id,
    };
    assert_expected_event_emitted(
        spied_event: events_after[1],
        expected_event: expected_create_event,
        expected_event_selector: @selector!("OpenNoteCreated"),
        expected_event_name: "OpenNoteCreated",
    );
    assert_expected_event_emitted(
        spied_event: events_after[2],
        expected_event: expected_withdrawal_event,
        expected_event_selector: @selector!("Withdrawal"),
        expected_event_name: "Withdrawal",
    );
    let expected_deposit_event = events::OpenNoteDeposited {
        depositor: swap_executor_addr,
        token: out_token_addr,
        note_id: open_note_id,
        amount: swap_amount,
    };
    assert_expected_event_emitted(
        spied_event: events_after[3],
        expected_event: expected_deposit_event,
        expected_event_selector: @selector!("OpenNoteDeposited"),
        expected_event_name: "OpenNoteDeposited",
    );
}

// TODO: move to common tests.
#[test]
fn test_send_message_to_server() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let random = user.get_random();
    let mut spy = spy_messages_to_l1();
    let contract_address = test.privacy.address;
    let client_actions = [ClientAction::SetViewingKey(SetViewingKeyInput { random })].span();
    test
        .privacy
        .execute_without_return(
            user_addr: user.address, user_private_key: user.private_key, :client_actions,
        );
    assert_eq!(spy.get_messages().messages.len(), 1);
    let (from, message) = spy.get_messages().messages.at(0);
    assert_eq!(*from, contract_address);
    assert_eq!(*message.to_address, Zero::zero());
    let mut payload = (*message.payload).span();
    let class_hash = *payload.pop_front().unwrap();
    assert_eq!(class_hash.try_into().unwrap(), get_class_hash(:contract_address));
    let server_actions = Serde::<Span<ServerAction>>::deserialize(ref payload)
        .expect('Failed deserialize');
    let expected_server_actions = test
        .privacy
        .compile_actions(
            user_addr: user.address, user_private_key: user.private_key, :client_actions,
        );
    assert_eq!(server_actions, expected_server_actions);
    assert!(payload.is_empty());
    // Assert message hash.
    let expected_message_hash = compute_message_hash(actions: server_actions, :contract_address);
    let mut message_data: Array<felt252> = array![contract_address.into()]; // from address.
    (*message).serialize(ref message_data);
    let message_hash = poseidon_hash_span(message_data.span());
    assert_eq!(expected_message_hash, message_hash);
}
