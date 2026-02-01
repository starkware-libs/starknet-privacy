use core::num::traits::Zero;
use privacy::actions::{
    AppendToVecInput, ServerAction, TransferFromInput, TransferToInput, VerifyValueInput,
    WriteOnceInput,
};
use privacy::objects::{EncPrivateKeyTrait, ToServerActionsTrait};
use privacy::tests::utils_for_tests::{
    NoteZero, PrivacyCfgTrait, Test, TestTrait, UserTrait, constants,
};
use privacy::{errors, events};
use snforge_std::{EventSpyTrait, EventsFilterTrait, TokenTrait, map_entry_address, spy_events};
use starkware_utils::components::pausable::PausableComponent::Errors as PausableErrors;
use starkware_utils::erc20::erc20_errors::Erc20Error;
use starkware_utils::errors::Describable;
use starkware_utils_testing::test_utils::{
    TokenHelperTrait, assert_expected_event_emitted, assert_panic_with_error,
    assert_panic_with_felt_error,
};

#[test]
fn test_set_viewing_key_multiple_users() {
    let mut test: Test = Default::default();
    let mut user1 = test.new_user();
    let mut user2 = test.new_user();
    let user3 = test.new_user();
    let public_key1 = user1.public_key;
    let public_key2 = user2.public_key;
    assert_ne!(public_key1, public_key2, "Public keys should be different.");

    // Register user1.
    user1.set_viewing_key_e2e();

    // Register user2.
    user2.set_viewing_key_e2e();

    // Verify both public keys are stored correctly.
    assert_eq!(user1.get_public_key(), public_key1);
    assert_eq!(user2.get_public_key(), public_key2);
    // User3 has not registered, so get_public_key should return zero.
    assert_eq!(user3.get_public_key(), Zero::zero());
}

#[test]
fn test_set_viewing_key_multiple_users_same_public_key() {
    let mut test: Test = Default::default();
    let mut user1 = test.new_user();
    let mut user2 = test.new_user();

    // Set the same key for both users.
    user2.private_key = user1.private_key;

    // Register both users.
    user1.set_viewing_key_e2e();
    user2.set_viewing_key_e2e();

    // Both should be able to fetch the shared public key.
    assert_eq!(user1.get_public_key(), user1.public_key);
    assert_eq!(user2.get_public_key(), user1.public_key);
}

#[test]
fn test_execute_write_once() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let (_, channel_id) = test.mock_new_channel();
    let (subchannel_id, _, _) = test.mock_new_subchannel();

    // Compute storage path felt using contract state.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [channel_id].span(),
    );

    // Verify channel doesn't exist and write.
    let actions: Array<ServerAction> = array![
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: storage_path_felt, value: [true.into()].span() },
        ),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify channel exists.
    assert!(test.privacy.channel_exists(:channel_id));

    // Verify subchannel doesn't exist and write.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [subchannel_id].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: storage_path_felt, value: [true.into()].span() },
        ),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify subchannel exists.
    assert!(test.privacy.subchannel_exists(:subchannel_id));

    // Verify user is not registered and write public key.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let actions: Array<ServerAction> = array![
        user.public_key.to_write_once_action(storage_address: storage_path_felt),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify public key was written.
    assert_eq!(user.get_public_key(), user.public_key);

    // Verify nullifier doesn't exist and write.
    let nullifier = test.mock_new_nullifier();
    let storage_path_felt = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    assert_eq!(test.privacy.nullifier_exists(:nullifier), false);
    let actions: Array<ServerAction> = array![
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: storage_path_felt, value: [true.into()].span() },
        ),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify nullifier was written.
    assert_eq!(test.privacy.nullifier_exists(:nullifier), true);
}

#[test]
fn test_execute_write_once_assertions() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let (_, channel_id) = test.mock_new_channel();
    let (subchannel_id, _, _) = test.mock_new_subchannel();

    // Catch NON_ZERO_VALUE for channel exists.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [channel_id].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: storage_path_felt, value: [true.into()].span() },
        ),
    ];
    test.privacy.execute_actions(actions.span());
    assert!(test.privacy.channel_exists(:channel_id));
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Catch NON_ZERO_VALUE for subchannel_exists.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [subchannel_id].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: storage_path_felt, value: [true.into()].span() },
        ),
    ];
    test.privacy.execute_actions(actions.span());
    assert!(test.privacy.subchannel_exists(:subchannel_id));
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Catch NON_ZERO_VALUE for public key.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let actions: Array<ServerAction> = array![
        user.public_key.to_write_once_action(storage_address: storage_path_felt),
    ];
    test.privacy.execute_actions(actions.span());
    assert_eq!(user.get_public_key(), user.public_key);
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Catch NON_ZERO_VALUE for nullifiers.
    let nullifier = test.mock_new_nullifier();
    let storage_path_felt = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: storage_path_felt, value: [true.into()].span() },
        ),
    ];
    test.privacy.execute_actions(actions.span());
    assert!(test.privacy.nullifier_exists(:nullifier));
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_write_once_subchannel() {
    let mut test: Test = Default::default();
    let (_, subchannel_key, enc_subchannel_info) = test.mock_new_subchannel();
    assert!(enc_subchannel_info.is_non_zero());

    // Verify subchannel info is zero before writing.
    let subchannel_info = test.privacy.get_subchannel_info(:subchannel_key);
    assert_eq!(subchannel_info.salt, Zero::zero());
    assert_eq!(subchannel_info.enc_token, Zero::zero());

    // Verify subchannel doesn't exist and write.
    let storage_address = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [subchannel_key].span(),
    );
    let actions = [enc_subchannel_info.to_write_once_action(:storage_address)].span();
    test.privacy.execute_actions(:actions);

    // Verify subchannel exists.
    assert_eq!(test.privacy.get_subchannel_info(:subchannel_key), enc_subchannel_info);
}

#[test]
fn test_execute_write_once_subchannel_assertions() {
    let mut test: Test = Default::default();
    let (_, subchannel_key, enc_subchannel_info) = test.mock_new_subchannel();
    assert!(enc_subchannel_info.is_non_zero());

    // Catch NON_ZERO_VALUE.
    let storage_address = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [subchannel_key].span(),
    );
    let actions = [enc_subchannel_info.to_write_once_action(:storage_address)].span();
    test.privacy.execute_actions(:actions);
    assert_eq!(test.privacy.get_subchannel_info(:subchannel_key), enc_subchannel_info);
    let result = test.privacy.safe_execute_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_write_once_private_key() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let enc_private_key = test.mock_new_enc_private_key();
    assert!(enc_private_key.is_all_non_zero());

    // Verify private key is zero before writing.
    let private_key = user.get_enc_private_key();
    assert_eq!(private_key.ephemeral_pubkey, Zero::zero());
    assert_eq!(private_key.enc_private_key, Zero::zero());

    // Write private key.
    let storage_address = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [user.address.into()].span(),
    );
    let actions = [enc_private_key.to_write_once_action(:storage_address)].span();
    test.privacy.execute_actions(:actions);

    // Verify private key exists.
    assert_eq!(user.get_enc_private_key(), enc_private_key);
}

#[test]
fn test_execute_write_once_private_key_assertions() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let enc_private_key = test.mock_new_enc_private_key();
    assert!(enc_private_key.is_all_non_zero());

    // Catch NON_ZERO_VALUE.
    let storage_address = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [user.address.into()].span(),
    );
    let actions = [enc_private_key.to_write_once_action(:storage_address)].span();
    test.privacy.execute_actions(:actions);
    assert_eq!(user.get_enc_private_key(), enc_private_key);
    let result = test.privacy.safe_execute_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_write_once_outgoing_channel() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let outgoing_channel_key = user.compute_outgoing_channel_key(index: 0);
    let enc_outgoing_channel_info = user
        .compute_enc_outgoing_channel_info(recipient: user, index: 0, salt: Zero::zero());
    assert!(outgoing_channel_key.is_non_zero());
    assert!(enc_outgoing_channel_info.is_non_zero());

    // Verify outgoing channel info is zero before writing.
    assert_eq!(test.privacy.get_outgoing_channel_info(:outgoing_channel_key), Zero::zero());

    // Write outgoing channel info.
    let storage_address = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [outgoing_channel_key].span(),
    );
    let actions = [enc_outgoing_channel_info.to_write_once_action(:storage_address)].span();
    test.privacy.execute_actions(:actions);

    // Verify outgoing channel info exists.
    assert_eq!(
        test.privacy.get_outgoing_channel_info(:outgoing_channel_key), enc_outgoing_channel_info,
    );
}
#[test]
fn test_execute_write_once_outgoing_channel_assertions() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let outgoing_channel_key = user.compute_outgoing_channel_key(index: 0);
    let enc_outgoing_channel_info = user
        .compute_enc_outgoing_channel_info(recipient: user, index: 0, salt: Zero::zero());
    assert!(outgoing_channel_key.is_non_zero());
    assert!(enc_outgoing_channel_info.is_non_zero());

    // Catch NON_ZERO_VALUE.
    let storage_address = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [outgoing_channel_key].span(),
    );
    let actions = [enc_outgoing_channel_info.to_write_once_action(:storage_address)].span();
    test.privacy.execute_actions(:actions);
    assert_eq!(
        test.privacy.get_outgoing_channel_info(:outgoing_channel_key), enc_outgoing_channel_info,
    );
    let result = test.privacy.safe_execute_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_write_once_note() {
    let mut test: Test = Default::default();
    let (note_id, note) = test.mock_new_note(amount: constants::DEFAULT_AMOUNT);
    assert!(note.packed_value.is_non_zero());

    // Verify stored note is zero before writing.
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    // Write stored note.
    let storage_address = map_entry_address(
        map_selector: selector!("notes"), keys: [note_id].span(),
    );
    let actions: Array<ServerAction> = array![note.to_write_once_action(:storage_address)];
    test.privacy.execute_actions(actions.span());

    // Verify stored note was written.
    assert_eq!(test.privacy.get_note(:note_id), note);
}

#[test]
fn test_execute_write_once_note_assertions() {
    let mut test: Test = Default::default();
    let (note_id, note) = test.mock_new_note(amount: constants::DEFAULT_AMOUNT);
    assert!(note.packed_value.is_non_zero());

    // Catch NON_ZERO_VALUE.
    let storage_address = map_entry_address(
        map_selector: selector!("notes"), keys: [note_id].span(),
    );
    let actions: Array<ServerAction> = array![note.to_write_once_action(:storage_address)];
    test.privacy.execute_actions(actions.span());
    // Verify the value was written
    assert_eq!(test.privacy.get_note(:note_id), note);
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_append_to_vector() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let (enc_channel_info, _) = test.mock_new_channel();

    // Append channel to vector
    let actions: Array<ServerAction> = array![
        ServerAction::AppendToVec(
            AppendToVecInput { recipient_addr: user.address, enc_channel_info: enc_channel_info },
        ),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify channel was added
    assert_eq!(user.get_num_of_channels(), 1);
    assert_eq!(user.get_channel_info(channel_index: 0), enc_channel_info);
}

#[test]
fn test_execute_transfer_from() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;

    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());

    // Verify balances before transfer.
    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    // Test transfer_from.
    let actions: Array<ServerAction> = array![
        ServerAction::TransferFrom(
            TransferFromInput {
                sender_addr: user.address, token: token.contract_address(), amount,
            },
        ),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify balances after transfer.
    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
}

#[test]
fn test_execute_transfer_from_assertions() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;

    // Catch INSUFFICIENT_BALANCE.
    let actions: Array<ServerAction> = array![
        ServerAction::TransferFrom(
            TransferFromInput {
                sender_addr: user.address, token: token.contract_address(), amount,
            },
        ),
    ];
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());

    // Catch INSUFFICIENT_ALLOWANCE.
    user.increase_token_balance(:token, :amount);
    let actions: Array<ServerAction> = array![
        ServerAction::TransferFrom(
            TransferFromInput {
                sender_addr: user.address, token: token.contract_address(), amount,
            },
        ),
    ];
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_ALLOWANCE.describe());
}

#[test]
fn test_execute_transfer_to() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let recipient = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;

    // Supply tokens to the server (via deposit).
    let mut user = test.new_user();
    let token_address = token.contract_address();
    user.set_viewing_key_e2e();
    user
        .open_channel_with_token_e2e(
            recipient: user, :token_address, outgoing_channel_index: 0, subchannel_index: 0,
        );
    let note = user
        .new_enc_note_with_generated_salt(recipient: user, :token_address, :amount, index: 0);
    user.increase_token_balance(:token, :amount);
    user.cheat_deposit(:token, :amount, create_note_input: note);

    // Verify balances before transfer.
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
    assert_eq!(token.balance_of(address: recipient.address), Zero::zero());

    // Test transfer_to.
    let actions: Array<ServerAction> = array![
        ServerAction::TransferTo(
            TransferToInput {
                recipient_addr: recipient.address, token: token.contract_address(), amount: amount,
            },
        ),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify balances after transfer.
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token.balance_of(address: recipient.address), amount.into());
}

#[test]
fn test_execute_transfer_to_assertions() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let recipient = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;

    // Catch INSUFFICIENT_BALANCE.
    let actions: Array<ServerAction> = array![
        ServerAction::TransferTo(
            TransferToInput {
                recipient_addr: recipient.address, token: token.contract_address(), amount: amount,
            },
        ),
    ];
    assert_lt!(token.balance_of(address: test.privacy.address), amount.into());
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());
}

#[test]
fn test_execute_verify_value() {
    let mut test: Test = Default::default();
    let user = test.new_user();

    // Write initial value.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let actions = array![user.public_key.to_write_once_action(storage_address: storage_path_felt)];
    test.privacy.execute_actions(actions.span());

    // Verify value by loading from storage.
    assert_eq!(user.get_public_key(), user.public_key);

    // Verify value by action.
    let actions = array![
        ServerAction::VerifyValue(
            VerifyValueInput { storage_address: storage_path_felt, value: user.public_key },
        ),
    ];
    test.privacy.execute_actions(actions.span());
}

#[test]
fn test_execute_verify_value_assertions() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );

    // Catch VALUE_MISMATCH.
    assert_ne!(user.get_public_key(), user.public_key);
    let actions = array![
        ServerAction::VerifyValue(
            VerifyValueInput { storage_address: storage_path_felt, value: user.public_key },
        ),
    ];
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::VALUE_MISMATCH);
}

#[test]
fn test_execute_emit_viewing_key_set() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let enc_private_key = test.mock_new_enc_private_key();
    let expected_event = events::ViewingKeySet {
        user_addr: user.address, public_key: user.public_key, enc_private_key,
    };
    let actions = array![ServerAction::EmitViewingKeySet(expected_event)];
    let mut spy = spy_events();
    test.privacy.execute_actions(actions.span());
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        :expected_event,
        expected_event_selector: @selector!("ViewingKeySet"),
        expected_event_name: "ViewingKeySet",
    );
}

#[test]
fn test_execute_emit_withdrawal() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let token = test.mock_new_token();
    let enc_user_addr = test.mock_new_enc_address();
    let expected_event = events::Withdrawal {
        enc_user_addr, withdrawal_target: user.address, token, amount: 1,
    };
    let actions = array![ServerAction::EmitWithdrawal(expected_event)];
    let mut spy = spy_events();
    test.privacy.execute_actions(actions.span());
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        :expected_event,
        expected_event_selector: @selector!("Withdrawal"),
        expected_event_name: "Withdrawal",
    );
}

#[test]
fn test_execute_emit_deposit() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let token = test.mock_new_token();
    let expected_event = events::Deposit { user_addr: user.address, token, amount: 1 };
    let actions = array![ServerAction::EmitDeposit(expected_event)];
    let mut spy = spy_events();
    test.privacy.execute_actions(actions.span());
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        :expected_event,
        expected_event_selector: @selector!("Deposit"),
        expected_event_name: "Deposit",
    );
}

#[test]
fn test_execute_actions_paused() {
    let mut test: Test = Default::default();
    test.privacy.pause();
    let result = test.privacy.safe_execute_actions([].span());
    assert_panic_with_felt_error(:result, expected_error: PausableErrors::PAUSED);
}

#[test]
fn test_execute_write_once_open_note() {
    // Test that server correctly writes all open note fields.
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

    let create_note_input = user_1.new_open_note(recipient: user_2, token: token_address, index: 0);
    let (note_id, expected_note) = user_1.compute_open_note(:create_note_input);

    // Compute the server actions to write the note to storage.
    let storage_address = map_entry_address(
        map_selector: selector!("notes"), keys: [note_id].span(),
    );
    let actions = [expected_note.to_write_once_action(:storage_address)].span();

    // Verify storage before execution.
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    // Execute server actions.
    test.privacy.execute_actions(:actions);

    // Verify storage after execution - both fields should be set.
    assert_eq!(test.privacy.get_note(:note_id), expected_note);
}

#[test]
fn test_execute_write_once_open_note_non_zero_token_fails() {
    // Test that trying to overwrite an existing open note fails.
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

    // Create open note first.
    let create_note_input = user_1.new_open_note(recipient: user_2, token: token_address, index: 0);
    user_1.cheat_create_open_note_e2e(:create_note_input);

    // Try to write again - should fail.
    let (note_id, expected_note) = user_1.compute_open_note(:create_note_input);
    let storage_address = map_entry_address(
        map_selector: selector!("notes"), keys: [note_id].span(),
    );
    let actions = [
        ServerAction::WriteOnce(
            WriteOnceInput {
                storage_address, value: [expected_note.packed_value, token_address.into()].span(),
            },
        ),
    ]
        .span();
    let result = test.privacy.safe_execute_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}
