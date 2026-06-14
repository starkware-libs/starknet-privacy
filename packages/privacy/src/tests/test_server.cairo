use core::num::traits::Zero;
use openzeppelin::security::ReentrancyGuardComponent::Errors as ReentrancyGuardErrors;
use privacy::actions::{
    AppendInput, InvokeInput, ServerAction, TransferFromInput, TransferToInput, UseNoteInput,
    WriteOnceInput,
};
use privacy::errors::internal_errors;
use privacy::objects::{EncOutgoingChannelInfo, Note, OpenNoteDeposit};
use privacy::test_contracts::mock_swap_executor::errors as mock_swap_executor_errors;
use privacy::tests::utils_for_tests::{
    CreateOpenNoteInputIntoServerActionTrait, InvokeExternalInputIntoServerActionTrait, NoteZero,
    PrivacyCfgTrait, Test, TestTrait, UserTrait, VesuTrait, constants, deploy_mock_reentrancy,
    deploy_mock_return_garbage, deploy_mock_return_trailing_garbage, deploy_mock_swap_executor,
    deploy_mock_vesu_vault_noop, invoke_mock_swap_executor_input, sign_screening_attestation,
    sign_screening_attestation_with,
};
use privacy::utils::constants::{
    DEPOSITOR_VALIDATION_MAX_AGE, DEPOSITOR_VALIDATION_MAX_FUTURE, OPEN_NOTE_SALT,
};
use privacy::utils::{
    ProofFacts, compute_message_hash, encrypt_user_addr, open_note, to_write_once_action, unpack,
};
use privacy::{errors, events};
use snforge_std::signature::KeyPairTrait;
use snforge_std::signature::stark_curve::StarkCurveKeyPairImpl;
use snforge_std::{
    CheatSpan, EventSpyTrait, EventsFilterTrait, TokenTrait, cheat_proof_facts, map_entry_address,
    spy_events, start_cheat_block_timestamp, stop_cheat_block_timestamp,
};
use starknet::{ContractAddress, get_block_number};
use starkware_utils::components::pausable::PausableComponent::Errors as PausableErrors;
use starkware_utils::constants::MAX_U128;
use starkware_utils::erc20::erc20_errors::Erc20Error;
use starkware_utils::errors::Describable;
use starkware_utils_testing::test_utils::{
    TokenHelperTrait, advance_block_number_global, assert_expected_event_emitted,
    assert_panic_with_error, assert_panic_with_felt_error,
};
use vesu_lending_anonymizer::vesu_lending_anonymizer::errors as vesu_errors;

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
fn test_apply_write_once() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let (_, channel_marker) = test.mock_new_channel();
    let (subchannel_marker, _, _) = test.mock_new_subchannel();

    // Compute storage path felt using contract state.
    let storage_address = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [channel_marker].span(),
    );

    // Verify channel doesn't exist and write.
    let actions: Array<ServerAction> = array![to_write_once_action(:storage_address, value: true)];
    test.privacy.apply_actions(actions.span());

    // Verify channel exists.
    assert!(test.privacy.channel_exists(:channel_marker));

    // Verify subchannel doesn't exist and write.
    let storage_address = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [subchannel_marker].span(),
    );
    let actions: Array<ServerAction> = array![to_write_once_action(:storage_address, value: true)];
    test.privacy.apply_actions(actions.span());

    // Verify subchannel exists.
    assert!(test.privacy.subchannel_exists(:subchannel_marker));

    // Verify user is not registered and write public key.
    let storage_address = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let actions: Array<ServerAction> = array![
        to_write_once_action(:storage_address, value: user.public_key),
    ];
    test.privacy.apply_actions(actions.span());

    // Verify public key was written.
    assert_eq!(user.get_public_key(), user.public_key);

    // Verify nullifier doesn't exist and write.
    let nullifier = test.mock_new_nullifier();
    let storage_address = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    assert_eq!(test.privacy.nullifier_exists(:nullifier), false);
    let actions: Array<ServerAction> = array![to_write_once_action(:storage_address, value: true)];
    test.privacy.apply_actions(actions.span());

    // Verify nullifier was written.
    assert_eq!(test.privacy.nullifier_exists(:nullifier), true);
}

#[test]
fn test_apply_write_once_assertions() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let (_, channel_marker) = test.mock_new_channel();
    let (subchannel_marker, _, _) = test.mock_new_subchannel();

    // Catch NON_ZERO_VALUE for channel exists.
    let storage_address = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [channel_marker].span(),
    );
    let actions: Array<ServerAction> = array![to_write_once_action(:storage_address, value: true)];
    test.privacy.apply_actions(actions.span());
    assert!(test.privacy.channel_exists(:channel_marker));
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Catch NON_ZERO_VALUE for subchannel_exists.
    let storage_address = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [subchannel_marker].span(),
    );
    let actions: Array<ServerAction> = array![to_write_once_action(:storage_address, value: true)];
    test.privacy.apply_actions(actions.span());
    assert!(test.privacy.subchannel_exists(:subchannel_marker));
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Catch NON_ZERO_VALUE for public key.
    let storage_address = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let actions: Array<ServerAction> = array![
        to_write_once_action(:storage_address, value: user.public_key),
    ];
    test.privacy.apply_actions(actions.span());
    assert_eq!(user.get_public_key(), user.public_key);
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Catch NON_ZERO_VALUE for nullifiers.
    let nullifier = test.mock_new_nullifier();
    let storage_address = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let actions: Array<ServerAction> = array![to_write_once_action(:storage_address, value: true)];
    test.privacy.apply_actions(actions.span());
    assert!(test.privacy.nullifier_exists(:nullifier));
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Catch UNEXPECTED_EMPTY_VALUE.
    let actions = [
        ServerAction::WriteOnce(WriteOnceInput { storage_address: 0x1, value: [].span() })
    ]
        .span();
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: internal_errors::UNEXPECTED_EMPTY_VALUE);

    // Catch UNEXPECTED_ZERO_VALUE.
    let storage_address = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let value: felt252 = Zero::zero();
    let actions: Array<ServerAction> = array![to_write_once_action(:storage_address, :value)];
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: internal_errors::UNEXPECTED_ZERO_VALUE);
}

#[test]
fn test_apply_write_once_subchannel() {
    let mut test: Test = Default::default();
    let (_, subchannel_id, enc_subchannel_info) = test.mock_new_subchannel();
    assert!(enc_subchannel_info.enc_token.is_non_zero());

    // Verify subchannel info is zero before writing.
    let subchannel_info = test.privacy.get_subchannel_info(:subchannel_id);
    assert_eq!(subchannel_info.salt, Zero::zero());
    assert_eq!(subchannel_info.enc_token, Zero::zero());

    // Verify subchannel doesn't exist and write.
    let storage_address = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [subchannel_id].span(),
    );
    let actions = [to_write_once_action(:storage_address, value: enc_subchannel_info)].span();
    test.privacy.apply_actions(:actions);

    // Verify subchannel exists.
    assert_eq!(test.privacy.get_subchannel_info(:subchannel_id), enc_subchannel_info);
}

#[test]
fn test_apply_write_once_subchannel_assertions() {
    let mut test: Test = Default::default();
    let (_, subchannel_id, enc_subchannel_info) = test.mock_new_subchannel();
    assert!(enc_subchannel_info.enc_token.is_non_zero());

    // Catch NON_ZERO_VALUE.
    let storage_address = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [subchannel_id].span(),
    );
    let actions = [to_write_once_action(:storage_address, value: enc_subchannel_info)].span();
    test.privacy.apply_actions(:actions);
    assert_eq!(test.privacy.get_subchannel_info(:subchannel_id), enc_subchannel_info);
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_apply_write_once_private_key() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let enc_private_key = test.mock_new_enc_private_key();

    // Verify private key is zero before writing.
    let private_key = user.get_enc_private_key();
    assert_eq!(private_key.ephemeral_pubkey, Zero::zero());
    assert_eq!(private_key.enc_private_key, Zero::zero());

    // Write private key.
    let storage_address = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [user.address.into()].span(),
    );
    let actions = [to_write_once_action(:storage_address, value: enc_private_key)].span();
    test.privacy.apply_actions(:actions);

    // Verify private key exists.
    assert_eq!(user.get_enc_private_key(), enc_private_key);
}

#[test]
fn test_apply_write_once_private_key_assertions() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let enc_private_key = test.mock_new_enc_private_key();

    // Catch NON_ZERO_VALUE.
    let storage_address = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [user.address.into()].span(),
    );
    let actions = [to_write_once_action(:storage_address, value: enc_private_key)].span();
    test.privacy.apply_actions(:actions);
    assert_eq!(user.get_enc_private_key(), enc_private_key);
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_apply_write_once_outgoing_channel() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let outgoing_channel_id = user.compute_outgoing_channel_id(index: 0);
    let enc_outgoing_channel_info = user
        .compute_enc_outgoing_channel_info(recipient: user, index: 0, salt: 1);
    assert!(outgoing_channel_id.is_non_zero());

    // Verify outgoing channel info is zero before writing.
    assert_eq!(
        test.privacy.get_outgoing_channel_info(:outgoing_channel_id),
        EncOutgoingChannelInfo { salt: Zero::zero(), enc_recipient_addr: Zero::zero() },
    );

    // Write outgoing channel info.
    let storage_address = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [outgoing_channel_id].span(),
    );
    let actions = [to_write_once_action(:storage_address, value: enc_outgoing_channel_info)].span();
    test.privacy.apply_actions(:actions);

    // Verify outgoing channel info exists.
    assert_eq!(
        test.privacy.get_outgoing_channel_info(:outgoing_channel_id), enc_outgoing_channel_info,
    );
}
#[test]
fn test_apply_write_once_outgoing_channel_assertions() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let outgoing_channel_id = user.compute_outgoing_channel_id(index: 0);
    let enc_outgoing_channel_info = user
        .compute_enc_outgoing_channel_info(recipient: user, index: 0, salt: 1);
    assert!(outgoing_channel_id.is_non_zero());

    // Catch NON_ZERO_VALUE.
    let storage_address = map_entry_address(
        map_selector: selector!("outgoing_channels"), keys: [outgoing_channel_id].span(),
    );
    let actions = [to_write_once_action(:storage_address, value: enc_outgoing_channel_info)].span();
    test.privacy.apply_actions(:actions);
    assert_eq!(
        test.privacy.get_outgoing_channel_info(:outgoing_channel_id), enc_outgoing_channel_info,
    );
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_apply_write_once_enc_note() {
    let mut test: Test = Default::default();
    let (note_id, note) = test.mock_new_note(amount: constants::DEFAULT_AMOUNT);
    assert!(note.packed_value.is_non_zero());

    // Verify stored note is zero before writing.
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    // Write stored note.
    let storage_address = map_entry_address(
        map_selector: selector!("notes"), keys: [note_id].span(),
    );
    let actions: Array<ServerAction> = array![
        to_write_once_action(:storage_address, value: note.packed_value),
    ];
    test.privacy.apply_actions(actions.span());

    // Verify stored note was written.
    assert_eq!(
        test.privacy.get_note(:note_id), Note { packed_value: note.packed_value, ..Zero::zero() },
    );
}

#[test]
fn test_apply_write_once_enc_note_assertions() {
    let mut test: Test = Default::default();
    let (note_id, note) = test.mock_new_note(amount: constants::DEFAULT_AMOUNT);
    assert!(note.packed_value.is_non_zero());

    // Catch NON_ZERO_VALUE.
    let storage_address = map_entry_address(
        map_selector: selector!("notes"), keys: [note_id].span(),
    );
    let actions: Array<ServerAction> = array![
        to_write_once_action(:storage_address, value: note.packed_value),
    ];
    test.privacy.apply_actions(actions.span());
    // Verify the value was written
    assert_eq!(
        test.privacy.get_note(:note_id), Note { packed_value: note.packed_value, ..Zero::zero() },
    );
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_apply_append() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let (enc_channel_info, _) = test.mock_new_channel();

    // Append channel to vector
    let actions: Array<ServerAction> = array![
        ServerAction::Append(
            AppendInput { recipient_addr: user.address, enc_channel_info: enc_channel_info },
        ),
    ];
    test.privacy.apply_actions(actions.span());

    // Verify channel was added
    assert_eq!(user.get_num_of_channels(), 1);
    assert_eq!(user.get_channel_info(channel_index: 0), enc_channel_info);
}

#[test]
fn test_apply_transfer_from() {
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
            TransferFromInput { from_addr: user.address, token: token.contract_address(), amount },
        ),
    ];
    test.privacy.apply_actions(actions.span());

    // Verify balances after transfer.
    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
}

#[test]
fn test_apply_transfer_from_assertions() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;

    // Catch INSUFFICIENT_BALANCE.
    let actions: Array<ServerAction> = array![
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user.address, token: token.contract_address(), amount },
        ),
    ];
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());

    // Catch INSUFFICIENT_ALLOWANCE.
    user.increase_token_balance(:token, :amount);
    let actions: Array<ServerAction> = array![
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user.address, token: token.contract_address(), amount },
        ),
    ];
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_ALLOWANCE.describe());
}

#[test]
fn test_apply_transfer_to() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let recipient = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;

    // Supply tokens to the server (via deposit).
    let mut user = test.new_user();
    let token_addr = token.contract_address();
    user.set_viewing_key_e2e();
    user.open_channel_with_token_e2e(recipient: user, :token_addr, outgoing_channel_index: 0);
    let note = user
        .new_enc_note_with_generated_salt(recipient: user, :token_addr, :amount, index: 0);
    user.increase_token_balance(:token, :amount);
    user.cheat_deposit(:token, :amount, create_note_input: note);

    // Verify balances before transfer.
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
    assert_eq!(token.balance_of(address: recipient.address), Zero::zero());

    // Test transfer_to.
    let actions: Array<ServerAction> = array![
        ServerAction::TransferTo(
            TransferToInput { to_addr: recipient.address, token: token.contract_address(), amount },
        ),
    ];
    test.privacy.apply_actions(actions.span());

    // Verify balances after transfer.
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token.balance_of(address: recipient.address), amount.into());
}

#[test]
fn test_apply_transfer_to_assertions() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let recipient = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;

    // Catch INSUFFICIENT_BALANCE.
    let actions: Array<ServerAction> = array![
        ServerAction::TransferTo(
            TransferToInput { to_addr: recipient.address, token: token.contract_address(), amount },
        ),
    ];
    assert_lt!(token.balance_of(address: test.privacy.address), amount.into());
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());
}

#[test]
fn test_apply_emit_viewing_key_set() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let enc_private_key = test.mock_new_enc_private_key();
    let expected_event = events::ViewingKeySet {
        user_addr: user.address, public_key: user.public_key, enc_private_key,
    };
    let actions = array![ServerAction::EmitViewingKeySet(expected_event)];
    let mut spy = spy_events();
    test.privacy.apply_actions(actions.span());
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
fn test_apply_emit_withdrawal() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let token = test.mock_new_token();
    let enc_user_addr = test.mock_new_enc_address();
    let expected_event = events::Withdrawal {
        enc_user_addr, to_addr: user.address, token, amount: 1,
    };
    let actions = array![ServerAction::EmitWithdrawal(expected_event)];
    let mut spy = spy_events();
    test.privacy.apply_actions(actions.span());
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
fn test_apply_emit_deposit() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let token = test.mock_new_token();
    let expected_event = events::Deposit { user_addr: user.address, token, amount: 1 };
    let actions = array![ServerAction::EmitDeposit(expected_event)];
    let mut spy = spy_events();
    test.privacy.apply_actions(actions.span());
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
fn test_apply_emit_open_note_created() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let echo_executor_addr = test.privacy.echo_executor;
    let enc_recipient_addr = test.mock_new_enc_address();
    let amount = constants::DEFAULT_AMOUNT;
    let (note_id, _) = test.mock_new_note(:amount);

    // Plant an empty open note in storage so the deposit can find it.
    let empty_note = open_note(token: token_addr);
    test.privacy.cheat_create_note(:note_id, note: empty_note);

    // Fund depositor.
    token.supply(address: echo_executor_addr, :amount);
    token.approve(owner: echo_executor_addr, spender: test.privacy.address, amount: amount.into());

    let expected_create_event = events::OpenNoteCreated {
        enc_recipient_addr, token: token_addr, note_id,
    };
    let expected_deposit_event = events::OpenNoteDeposited {
        depositor: echo_executor_addr, token: token_addr, note_id, amount,
    };
    let deposit = OpenNoteDeposit { note_id, token: token_addr, amount };
    let deposit_actions = test
        .privacy
        .invoke_external_echo_deposits([deposit].span())
        .into_server_actions();
    let mut actions: Array<ServerAction> = array![
        ServerAction::EmitOpenNoteCreated(expected_create_event),
    ];
    actions.append_span(deposit_actions);
    let mut spy = spy_events();
    test.privacy.apply_actions(actions.span());
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 2);
    assert_expected_event_emitted(
        spied_event: events[0],
        expected_event: expected_create_event,
        expected_event_selector: @selector!("OpenNoteCreated"),
        expected_event_name: "OpenNoteCreated",
    );
    assert_expected_event_emitted(
        spied_event: events[1],
        expected_event: expected_deposit_event,
        expected_event_selector: @selector!("OpenNoteDeposited"),
        expected_event_name: "OpenNoteDeposited",
    );
}

#[test]
fn test_apply_emit_enc_note_created() {
    let mut test: Test = Default::default();
    let note_id = 'NOTE_ID';
    let packed_value = 'PACKED_VALUE';
    let expected_event = events::EncNoteCreated { note_id, packed_value };
    let actions = array![ServerAction::EmitEncNoteCreated(expected_event)];
    let mut spy = spy_events();
    test.privacy.apply_actions(actions.span());
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        :expected_event,
        expected_event_selector: @selector!("EncNoteCreated"),
        expected_event_name: "EncNoteCreated",
    );
}

#[test]
fn test_apply_emit_note_used() {
    let mut test: Test = Default::default();
    let nullifier = test.mock_new_nullifier();
    let expected_event = events::NoteUsed { nullifier };
    let actions = array![ServerAction::EmitNoteUsed(expected_event)];
    let mut spy = spy_events();
    test.privacy.apply_actions(actions.span());
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        :expected_event,
        expected_event_selector: @selector!("NoteUsed"),
        expected_event_name: "NoteUsed",
    );
}

#[test]
fn test_apply_actions_paused() {
    let mut test: Test = Default::default();
    test.privacy.pause();
    let result = test.privacy.safe_apply_actions([].span());
    assert_panic_with_felt_error(:result, expected_error: PausableErrors::PAUSED);
}

#[test]
fn test_apply_actions_reentrancy_locked() {
    let mut test: Test = Default::default();
    let reentrancy_mock = deploy_mock_reentrancy();
    let invoke_input = InvokeInput { contract_address: reentrancy_mock, calldata: [].span() };
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: ReentrancyGuardErrors::REENTRANT_CALL);
}

#[test]
fn test_apply_actions_assertions() {
    let mut test: Test = Default::default();
    let actions = [].span();
    let proof_facts: ProofFacts = Default::default();

    // Catch EMPTY_PROOF_FACTS (no proof facts cheated).
    let result = test.privacy.safe_apply_actions_without_cheat(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::EMPTY_PROOF_FACTS);

    // Catch PROOF_FACTS_DESERIALIZE_ERROR (non-empty but invalid serialization).
    let invalid_proof_facts = [0x1].span();
    cheat_proof_facts(
        contract_address: test.privacy.address,
        proof_facts: invalid_proof_facts,
        span: CheatSpan::TargetCalls(1),
    );
    let result = test.privacy.safe_apply_actions_without_cheat(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::PROOF_FACTS_DESERIALIZE_ERROR);

    // Catch INVALID_PROOF_FACTS.
    let mut serialized_proof_facts = array![];
    proof_facts.serialize(ref serialized_proof_facts);
    serialized_proof_facts.append(0x1);
    cheat_proof_facts(
        contract_address: test.privacy.address,
        proof_facts: serialized_proof_facts.span(),
        span: CheatSpan::TargetCalls(1),
    );
    let result = test.privacy.safe_apply_actions_without_cheat(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_PROOF_FACTS);

    // Catch INVALID_PROGRAM_VARIANT.
    let mut proof_facts_invalid_program_variant = proof_facts;
    proof_facts_invalid_program_variant.program_variant = 1;
    let result = test
        .privacy
        .safe_apply_actions_with_proof_facts(
            :actions, proof_facts: proof_facts_invalid_program_variant,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_PROGRAM_VARIANT);

    // Catch INVALID_OS_OUTPUT_VERSION.
    let mut proof_facts_invalid_os_output_version = proof_facts;
    proof_facts_invalid_os_output_version.starknet_os_output_version = 1;
    let result = test
        .privacy
        .safe_apply_actions_with_proof_facts(
            :actions, proof_facts: proof_facts_invalid_os_output_version,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_OS_OUTPUT_VERSION);

    // Catch INVALID_PROOF_MSG.
    let result = test.privacy.safe_apply_actions_with_proof_facts(:actions, :proof_facts);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_PROOF_MSG);
    let mut proof_facts_invalid_proof_msg = proof_facts;
    proof_facts_invalid_proof_msg.message_to_l1_hashes = [0x1].span();
    let result = test
        .privacy
        .safe_apply_actions_with_proof_facts(:actions, proof_facts: proof_facts_invalid_proof_msg);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_PROOF_MSG);
    let mut proof_facts_invalid_proof_msg = proof_facts;
    let message_hash = compute_message_hash(:actions, contract_address: test.privacy.address);
    proof_facts_invalid_proof_msg.message_to_l1_hashes = [message_hash, message_hash].span();
    let result = test
        .privacy
        .safe_apply_actions_with_proof_facts(:actions, proof_facts: proof_facts_invalid_proof_msg);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_PROOF_MSG);

    // Catch PROOF_EXPIRED.
    let mut proof_facts_expired = proof_facts;
    proof_facts_expired.base_block_number = get_block_number();
    advance_block_number_global(blocks: test.privacy.get_proof_validity_blocks() + 1);
    let result = test
        .privacy
        .safe_apply_actions_with_proof_facts(:actions, proof_facts: proof_facts_expired);
    assert_panic_with_felt_error(:result, expected_error: errors::PROOF_EXPIRED);

    // Catch INVALID_BASE_BLOCK_NUMBER (future block).
    let mut proof_facts_invalid_base_block_number = proof_facts;
    proof_facts_invalid_base_block_number.base_block_number = get_block_number() + 1;
    let result = test
        .privacy
        .safe_apply_actions_with_proof_facts(
            :actions, proof_facts: proof_facts_invalid_base_block_number,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_BASE_BLOCK_NUMBER);

    // Catch INVALID_BASE_BLOCK_NUMBER (current block; proof base must be strictly in the past).
    let mut proof_facts_current_block = proof_facts;
    proof_facts_current_block.base_block_number = get_block_number();
    let result = test
        .privacy
        .safe_apply_actions_with_proof_facts(:actions, proof_facts: proof_facts_current_block);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_BASE_BLOCK_NUMBER);
}

#[test]
fn test_apply_actions_proof_facts_cheat() {
    let mut test: Test = Default::default();
    let actions = [].span();
    test.privacy.apply_actions(:actions);
}

#[test]
fn test_apply_write_once_open_note() {
    // Test that server correctly writes all open note fields.
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_addr = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);

    let create_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0);
    let (note_id, expected_note) = user_1.compute_open_note(:create_note_input);

    // Compute the server actions to write the note to storage.
    let storage_address = map_entry_address(
        map_selector: selector!("notes"), keys: [note_id].span(),
    );
    let actions = [to_write_once_action(:storage_address, value: expected_note)].span();

    // Verify storage before execution.
    assert_eq!(test.privacy.get_note(:note_id), Zero::zero());

    // Execute server actions.
    test.privacy.apply_actions(:actions);

    // Verify storage after execution - both fields should be set.
    assert_eq!(test.privacy.get_note(:note_id), expected_note);
}

#[test]
fn test_apply_write_once_open_note_assertions() {
    // Test that trying to overwrite an existing open note fails.
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_addr = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);

    // Create open note first.
    let create_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0);
    user_1.cheat_create_open_note(:create_note_input);

    // Try to write again - should fail.
    let actions = create_note_input.into_server_actions(user: user_1);
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_deposit_to_open_note() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let mut user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    let token_addr = token.contract_address();
    let echo_executor = test.privacy.echo_executor;

    // Setup user and channel.
    user.set_viewing_key_e2e();
    user.open_channel_with_token_e2e(recipient: user, :token_addr, outgoing_channel_index: 0);

    let create_note_input = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, index: 0);
    token.supply(address: echo_executor, :amount);
    token.approve(owner: echo_executor, spender: test.privacy.address, amount: amount.into());
    let (note_id, actions) = user.create_and_deposit_to_open_note(:create_note_input, :amount);

    assert_eq!(token.balance_of(address: echo_executor), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    // Spy on events before executing.
    let mut spy = spy_events();

    test.privacy.apply_actions(:actions);

    // Verify note packed_value updated with OPEN_NOTE_SALT and amount.
    let deposited_note = test.privacy.get_note(:note_id);
    let (salt, stored_amount) = unpack(packed_value: deposited_note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, amount);
    assert_eq!(deposited_note.token, token_addr);

    // Verify tokens transferred.
    assert_eq!(token.balance_of(address: echo_executor), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    // Verify OpenNoteCreated and OpenNoteDeposited events emitted.
    let expected_create_event = events::OpenNoteCreated {
        enc_recipient_addr: encrypt_user_addr(
            ephemeral_secret: create_note_input.random,
            auditor_public_key: test.privacy.get_auditor_public_key(),
            user_addr: user.address,
        ),
        token: token_addr,
        note_id,
    };
    let expected_deposit_event = events::OpenNoteDeposited {
        depositor: echo_executor, token: token_addr, note_id, amount,
    };
    let emitted_events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(emitted_events.len(), 2);
    assert_expected_event_emitted(
        spied_event: emitted_events[0],
        expected_event: expected_create_event,
        expected_event_selector: @selector!("OpenNoteCreated"),
        expected_event_name: "OpenNoteCreated",
    );
    assert_expected_event_emitted(
        spied_event: emitted_events[1],
        expected_event: expected_deposit_event,
        expected_event_selector: @selector!("OpenNoteDeposited"),
        expected_event_name: "OpenNoteDeposited",
    );
}

#[test]
fn test_deposit_to_open_note_blocked_depositor() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let mut user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    let token_addr = token.contract_address();
    let echo_executor = test.privacy.echo_executor;

    user.set_viewing_key_e2e();
    user.open_channel_with_token_e2e(recipient: user, :token_addr, outgoing_channel_index: 0);

    let create_note_input = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, index: 0);
    token.supply(address: echo_executor, :amount);
    token.approve(owner: echo_executor, spender: test.privacy.address, amount: amount.into());
    let (note_id, actions) = user.create_and_deposit_to_open_note(:create_note_input, :amount);

    // The depositor for echo-executor open-note deposits is the Invoke target (echo_executor).
    test.privacy.set_open_note_depositor_blocked(depositor: echo_executor, blocked: true);
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::OPEN_NOTE_DEPOSITOR_BLOCKED);

    // Nothing transferred and the note is still empty (the revert undid all state).
    assert_eq!(token.balance_of(address: echo_executor), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    // Unblocking lets the same deposit succeed.
    test.privacy.set_open_note_depositor_blocked(depositor: echo_executor, blocked: false);
    test.privacy.apply_actions(:actions);

    let deposited_note = test.privacy.get_note(:note_id);
    let (salt, stored_amount) = unpack(packed_value: deposited_note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, amount);
    assert_eq!(token.balance_of(address: echo_executor), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
}

#[test]
fn test_invoke_from_blocked_address_without_open_note_deposit_is_allowed() {
    let mut test: Test = Default::default();
    let echo_executor = test.privacy.echo_executor;

    // Block the echo executor — the address that would be the open-note depositor if it funded
    // one.
    test.privacy.set_open_note_depositor_blocked(depositor: echo_executor, blocked: true);

    // Invoke the (blocked) echo executor but have it return NO open-note deposits.
    let no_deposits: Span<OpenNoteDeposit> = array![].span();
    let actions = test.privacy.invoke_external_echo_deposits(no_deposits).into_server_actions();

    // The block list is only consulted when an Invoke yields open-note deposits. With none, the tx
    // succeeds even though the Invoke target is blocked (no `OPEN_NOTE_DEPOSITOR_BLOCKED` revert).
    test.privacy.apply_actions(:actions);
}

#[test]
fn test_deposit_to_open_note_assertions() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let mut user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    let token_addr = token.contract_address();

    // Setup: user needs viewing key, channel, subchannel for into_server_actions.
    user.set_viewing_key_e2e();
    user.open_channel_e2e(recipient: user, index: 0);
    user.open_subchannel_e2e(recipient: user, :token_addr, index: 0);

    // Shared create_input for all reverting sub-tests.
    let create_input = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, index: 0);
    let create_actions = create_input.into_server_actions(:user);
    let (note_id, _) = user.compute_open_note(create_note_input: create_input);

    // Catch ZERO_TOKEN - create valid note, deposit with zero token.
    let result = test
        .privacy
        .safe_create_open_note_and_invoke(
            create_actions, note_id, token_addr: Zero::zero(), :amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT - create valid note, deposit with zero amount.
    let result = test
        .privacy
        .safe_create_open_note_and_invoke(create_actions, :note_id, :token_addr, amount: 0);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);

    // Catch NOTE_NOT_FOUND - create note A, deposit targeting non-existent note B.
    let result = test
        .privacy
        .safe_create_open_note_and_invoke(
            create_actions, note_id: 'NONEXISTENT', :token_addr, :amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    // Catch NOTE_NOT_OPEN - create open note A, cheat enc note at different id, deposit to enc.
    let enc_note_input = user
        .new_enc_note_with_generated_salt(recipient: user, :token_addr, :amount, index: 99);
    let (note_id_enc, enc_note) = user.compute_enc_note(create_note_input: enc_note_input);
    test.privacy.cheat_create_note(note_id: note_id_enc, note: enc_note);
    let result = test
        .privacy
        .safe_create_open_note_and_invoke(
            create_actions, note_id: note_id_enc, :token_addr, :amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_OPEN);

    // Catch TOKEN_MISMATCH - create open note for token A, deposit with token B.
    let result = test
        .privacy
        .safe_create_open_note_and_invoke(
            create_actions, :note_id, token_addr: test.mock_new_token(), :amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::TOKEN_MISMATCH);

    // Catch NOTE_ALREADY_DEPOSITED - create+deposit to note A, then create B + deposit targeting A.
    // Previous sub-tests all reverted, so the contract's index counter is still 0.
    let note_id_deposited = user
        .create_and_deposit_to_open_note_e2e(create_note_input: create_input, :amount, :token);
    let create_input_b = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, index: 1);
    let create_actions_b = create_input_b.into_server_actions(:user);
    let result = test
        .privacy
        .safe_create_open_note_and_invoke(
            create_actions_b, note_id: note_id_deposited, :token_addr, :amount,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_ALREADY_DEPOSITED);
}

#[test]
fn test_deposit_to_open_note_transfer_assertions() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let mut user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    let token_addr = token.contract_address();
    let echo_executor_addr = test.privacy.echo_executor;

    user.set_viewing_key_e2e();
    user.open_channel_e2e(recipient: user, index: 0);
    user.open_subchannel_e2e(recipient: user, :token_addr, index: 0);

    let create_input = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, index: 0);
    let create_actions = create_input.into_server_actions(:user);
    let (note_id, _) = user.compute_open_note(create_note_input: create_input);

    // Test 1: INSUFFICIENT_BALANCE - Echo executor has no tokens.
    let result = test
        .privacy
        .safe_create_open_note_and_invoke(create_actions, :note_id, :token_addr, :amount);
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());

    // Test 2: INSUFFICIENT_ALLOWANCE - Echo executor has tokens but no approval.
    // Reuse the same note since Test 1 failed and didn't modify the note state.
    token.supply(address: echo_executor_addr, :amount);
    // Note: NOT calling approve here.
    let result = test
        .privacy
        .safe_create_open_note_and_invoke(create_actions, :note_id, :token_addr, :amount);
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_ALLOWANCE.describe());
}

#[test]
fn test_apply_invoke_swap() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let executor_addr = test.privacy.swap_executor.address;
    let amm_address = test.privacy.mock_amm;

    // Create an open note with swap_executor.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let recipient = user;
    user.open_channel_e2e(:recipient, index: 0);
    user.open_subchannel_e2e(:recipient, token_addr: output_token.contract_address(), index: 0);
    let create_note_input = user
        .new_open_note_with_generated_random(
            :recipient, token_addr: output_token.contract_address(), index: 0,
        );
    let (note_id, _) = user.compute_open_note(:create_note_input);
    let create_actions = create_note_input.into_server_actions(:user);

    // Fund swap executor with input tokens.
    input_token.supply(address: executor_addr, amount: swap_amount);

    // Fund AMM with output tokens.
    output_token.supply(address: amm_address, amount: swap_amount);

    // Verify balances before swap.
    assert_eq!(input_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(input_token.balance_of(address: executor_addr), swap_amount.into());
    assert_eq!(input_token.balance_of(address: amm_address), 0);
    assert_eq!(output_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(output_token.balance_of(address: executor_addr), 0);
    assert_eq!(output_token.balance_of(address: amm_address), swap_amount.into());

    // Create Invoke input.
    let invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        :note_id,
    );

    // Spy on events before executing.
    let mut spy = spy_events();

    // Create note and execute swap in the same apply_actions call.
    let mut actions: Array<ServerAction> = create_actions.into();
    actions.append(ServerAction::Invoke(invoke_input));
    test.privacy.apply_actions(actions.span());

    // Verify open note was deposited to with swap amount.
    let deposited_note = test.privacy.get_note(:note_id);
    let (deposited_salt, deposited_amount) = unpack(packed_value: deposited_note.packed_value);
    assert_eq!(deposited_salt, OPEN_NOTE_SALT);
    assert_eq!(deposited_amount, swap_amount);
    assert_eq!(deposited_note.token, output_token.contract_address());

    // Verify balances after swap.
    // Input tokens: swap_executor -> AMM (via swap).
    assert_eq!(input_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(input_token.balance_of(address: executor_addr), 0);
    assert_eq!(input_token.balance_of(address: amm_address), swap_amount.into());
    // Output tokens: AMM -> swap_executor -> privacy (via deposit).
    assert_eq!(output_token.balance_of(address: test.privacy.address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: executor_addr), 0);
    assert_eq!(output_token.balance_of(address: amm_address), 0);

    // Verify OpenNoteCreated and OpenNoteDeposited events emitted.
    let expected_create_event = events::OpenNoteCreated {
        enc_recipient_addr: encrypt_user_addr(
            ephemeral_secret: create_note_input.random,
            auditor_public_key: test.privacy.get_auditor_public_key(),
            user_addr: recipient.address,
        ),
        token: output_token.contract_address(),
        note_id,
    };
    let expected_deposit_event = events::OpenNoteDeposited {
        depositor: executor_addr,
        token: output_token.contract_address(),
        note_id,
        amount: swap_amount,
    };
    let emitted_events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(emitted_events.len(), 2);
    assert_expected_event_emitted(
        spied_event: emitted_events[0],
        expected_event: expected_create_event,
        expected_event_selector: @selector!("OpenNoteCreated"),
        expected_event_name: "OpenNoteCreated",
    );
    assert_expected_event_emitted(
        spied_event: emitted_events[1],
        expected_event: expected_deposit_event,
        expected_event_selector: @selector!("OpenNoteDeposited"),
        expected_event_name: "OpenNoteDeposited",
    );
}

#[test]
fn test_apply_invoke_missing_selector() {
    let mut test: Test = Default::default();
    let amm_address = test.privacy.mock_amm;

    // Invoke the AMM contract which doesn't have `privacy_invoke` - should fail with
    // ENTRYPOINT_NOT_FOUND.
    let invoke_input = InvokeInput { contract_address: amm_address, calldata: [].span() };
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: 'ENTRYPOINT_NOT_FOUND');

    // Invoke the privacy contract iteslf, which doesn't have `privacy_invoke` - should fail with
    // ENTRYPOINT_NOT_FOUND.
    let invoke_input = InvokeInput { contract_address: test.privacy.address, calldata: [].span() };
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: 'ENTRYPOINT_NOT_FOUND');
}

#[test]
fn test_apply_invoke_return_deserialize_error() {
    let mut test: Test = Default::default();
    let mock_return_garbage_addr = deploy_mock_return_garbage();
    let invoke_input = InvokeInput {
        contract_address: mock_return_garbage_addr, calldata: [].span(),
    };
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_INVOKE_RETURN_DATA);
}

#[test]
fn test_apply_invoke_return_extra_data() {
    let mut test: Test = Default::default();
    let mock_return_trailing_garbage_addr = deploy_mock_return_trailing_garbage();
    let invoke_input = InvokeInput {
        contract_address: mock_return_trailing_garbage_addr, calldata: [].span(),
    };
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_INVOKE_RETURN_DATA);
}

#[test]
fn test_apply_invoke_propagates_panic() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let executor_addr = test.privacy.swap_executor.address;

    // Don't fund the swap executor - `privacy_invoke` will panic with INSUFFICIENT_BALANCE.
    let invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        note_id: 'SOME_NOTE',
    );
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(invoke_input)].span());
    assert_panic_with_felt_error(
        :result, expected_error: mock_swap_executor_errors::INSUFFICIENT_BALANCE,
    );
}

#[test]
fn test_apply_invoke_swap_with_executor_assertions() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let executor_addr = test.privacy.swap_executor.address;
    let amm_address = test.privacy.mock_amm;

    // Create an open note with swap_executor.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let recipient = user;
    user.open_channel_e2e(:recipient, index: 0);
    user.open_subchannel_e2e(:recipient, token_addr: output_token.contract_address(), index: 0);
    let create_note_input = user
        .new_open_note_with_generated_random(
            :recipient, token_addr: output_token.contract_address(), index: 0,
        );
    user.cheat_create_open_note(:create_note_input);
    let (note_id, _) = user.compute_open_note(:create_note_input);

    // Base valid invoke input (will be modified for each error case).
    let valid_invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        :note_id,
    );

    // Catch ZERO_IN_TOKEN
    let zero_in_token_invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: Zero::zero(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        :note_id,
    );
    let result = test
        .privacy
        .safe_apply_actions([ServerAction::Invoke(zero_in_token_invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: mock_swap_executor_errors::ZERO_IN_TOKEN);

    // Catch ZERO_OUT_TOKEN
    let zero_out_token_invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: Zero::zero(),
        in_amount: swap_amount,
        :note_id,
    );
    let result = test
        .privacy
        .safe_apply_actions([ServerAction::Invoke(zero_out_token_invoke_input)].span());
    assert_panic_with_felt_error(
        :result, expected_error: mock_swap_executor_errors::ZERO_OUT_TOKEN,
    );

    // Catch ZERO_IN_AMOUNT
    let zero_in_amount_invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: 0,
        :note_id,
    );
    let result = test
        .privacy
        .safe_apply_actions([ServerAction::Invoke(zero_in_amount_invoke_input)].span());
    assert_panic_with_felt_error(
        :result, expected_error: mock_swap_executor_errors::ZERO_IN_AMOUNT,
    );

    // Catch IN_TOKEN_EQUAL_TO_OUT_TOKEN
    let in_token_equal_to_out_token_invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: input_token.contract_address(),
        in_amount: swap_amount,
        :note_id,
    );
    let result = test
        .privacy
        .safe_apply_actions(
            [ServerAction::Invoke(in_token_equal_to_out_token_invoke_input)].span(),
        );
    assert_panic_with_felt_error(
        :result, expected_error: mock_swap_executor_errors::IN_TOKEN_EQUAL_TO_OUT_TOKEN,
    );

    // Catch INSUFFICIENT_BALANCE.
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(valid_invoke_input)].span());
    assert_panic_with_felt_error(
        :result, expected_error: mock_swap_executor_errors::INSUFFICIENT_BALANCE,
    );

    // Catch INSUFFICIENT_BALANCE from AMM.
    // Fund swap executor with input tokens.
    input_token.supply(address: executor_addr, amount: swap_amount);
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(valid_invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: 'ERC20: insufficient balance');

    // Catch ZERO_OUT_AMOUNT
    // Fund swap executor with input tokens.
    let noop_swap_executor = deploy_mock_swap_executor(
        :amm_address, selector: selector!("noop_swap"),
    );
    input_token.supply(address: noop_swap_executor, amount: swap_amount);
    let noop_invoke_input = invoke_mock_swap_executor_input(
        swap_executor: noop_swap_executor,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        :note_id,
    );
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(noop_invoke_input)].span());
    assert_panic_with_felt_error(
        :result, expected_error: mock_swap_executor_errors::ZERO_OUT_AMOUNT,
    );

    // Catch RECEIVED_AMOUNT_OVERFLOW
    let overflow_swap_executor = deploy_mock_swap_executor(
        :amm_address, selector: selector!("overflow_swap"),
    );
    // Fund AMM with MAX_U128 + 1 output tokens (supply takes u128, so we call it twice).
    output_token.supply(address: amm_address, amount: MAX_U128);
    output_token.supply(address: amm_address, amount: 1);
    // Fund swap executor with input tokens.
    input_token.supply(address: overflow_swap_executor, amount: swap_amount);
    let overflow_invoke_input = invoke_mock_swap_executor_input(
        swap_executor: overflow_swap_executor,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        :note_id,
    );
    let result = test
        .privacy
        .safe_apply_actions([ServerAction::Invoke(overflow_invoke_input)].span());
    assert_panic_with_felt_error(
        :result, expected_error: mock_swap_executor_errors::RECEIVED_AMOUNT_OVERFLOW,
    );
}

#[test]
fn test_apply_swap_with_executor_deposit_assertions() {
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let executor_addr = test.privacy.swap_executor.address;
    let amm_address = test.privacy.mock_amm;
    let token_addr = output_token.contract_address();
    let privacy_address = test.privacy.address;

    // Setup user with viewing key and subchannel.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let recipient = user;
    user.open_channel_e2e(:recipient, index: 0);
    user.open_subchannel_e2e(:recipient, token_addr: output_token.contract_address(), index: 0);
    user.open_subchannel_e2e(:recipient, token_addr: input_token.contract_address(), index: 1);

    // Fund swap executor with input tokens (enough for multiple attempts).
    input_token.supply(address: executor_addr, amount: swap_amount * 4);

    // Fund AMM with output tokens (enough for multiple swaps).
    output_token.supply(address: amm_address, amount: swap_amount * 4);

    // Initial balances (after funding).
    assert_eq!(input_token.balance_of(address: privacy_address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor_addr), (swap_amount * 4).into());
    assert_eq!(input_token.balance_of(address: amm_address), Zero::zero());
    assert_eq!(output_token.balance_of(address: privacy_address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor_addr), Zero::zero());
    assert_eq!(output_token.balance_of(address: amm_address), (swap_amount * 4).into());

    // Shared create_input for reverting sub-tests (NOTE_NOT_OPEN, NOTE_NOT_FOUND).
    let create_input = user.new_open_note_with_generated_random(:recipient, :token_addr, index: 1);
    let create_actions = create_input.into_server_actions(:user);

    // Catch NOTE_NOT_OPEN
    let enc_note_input = user
        .new_enc_note_with_generated_salt(
            recipient: user, :token_addr, amount: swap_amount, index: 0,
        );
    user.cheat_create_enc_note_e2e(create_note_input: enc_note_input);
    let (note_id_enc, _) = user.compute_enc_note(create_note_input: enc_note_input);
    let invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        note_id: note_id_enc,
    );
    let mut actions: Array<ServerAction> = create_actions.into();
    actions.append(ServerAction::Invoke(invoke_input));
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_OPEN);
    // Balances unchanged (revert).
    assert_eq!(input_token.balance_of(address: privacy_address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor_addr), (swap_amount * 4).into());
    assert_eq!(input_token.balance_of(address: amm_address), Zero::zero());
    assert_eq!(output_token.balance_of(address: privacy_address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor_addr), Zero::zero());
    assert_eq!(output_token.balance_of(address: amm_address), (swap_amount * 4).into());

    // Catch NOTE_NOT_FOUND
    let invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        note_id: 'NONEXISTENT_NOTE',
    );
    let mut actions: Array<ServerAction> = create_actions.into();
    actions.append(ServerAction::Invoke(invoke_input));
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);
    // Balances unchanged (revert).
    assert_eq!(input_token.balance_of(address: privacy_address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor_addr), (swap_amount * 4).into());
    assert_eq!(input_token.balance_of(address: amm_address), Zero::zero());
    assert_eq!(output_token.balance_of(address: privacy_address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor_addr), Zero::zero());
    assert_eq!(output_token.balance_of(address: amm_address), (swap_amount * 4).into());

    // Catch TOKEN_MISMATCH: create open note for input token, swap deposits output token.
    let create_input_mismatch = user
        .new_open_note_with_generated_random(
            :recipient, token_addr: input_token.contract_address(), index: 1,
        );
    let create_actions_mismatch = create_input_mismatch.into_server_actions(:user);
    let (note_id_mismatch, _) = user.compute_open_note(create_note_input: create_input_mismatch);
    let invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        note_id: note_id_mismatch,
    );
    let mut actions: Array<ServerAction> = create_actions_mismatch.into();
    actions.append(ServerAction::Invoke(invoke_input));
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::TOKEN_MISMATCH);
    // Balances unchanged (revert).
    assert_eq!(input_token.balance_of(address: privacy_address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor_addr), (swap_amount * 4).into());
    assert_eq!(input_token.balance_of(address: amm_address), Zero::zero());
    assert_eq!(output_token.balance_of(address: privacy_address), Zero::zero());
    assert_eq!(output_token.balance_of(address: executor_addr), Zero::zero());
    assert_eq!(output_token.balance_of(address: amm_address), (swap_amount * 4).into());

    // Catch NOTE_ALREADY_DEPOSITED: first swap with creation succeeds, second fails.
    // Previous sub-tests all reverted, so the contract's counters are still 0.
    let create_input_a = user
        .new_open_note_with_generated_random(:recipient, :token_addr, index: 1);
    let create_actions_a = create_input_a.into_server_actions(:user);
    let (note_id_deposited, _) = user.compute_open_note(create_note_input: create_input_a);
    let invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        note_id: note_id_deposited,
    );
    let mut actions: Array<ServerAction> = create_actions_a.into();
    actions.append(ServerAction::Invoke(invoke_input));
    test.privacy.apply_actions(actions.span());
    // Balances after successful swap: input executor->amm, output amm->privacy (via executor).
    assert_eq!(input_token.balance_of(address: privacy_address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor_addr), (swap_amount * 3).into());
    assert_eq!(input_token.balance_of(address: amm_address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: privacy_address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: executor_addr), Zero::zero());
    assert_eq!(output_token.balance_of(address: amm_address), (swap_amount * 3).into());

    // Second swap: create note B (for count), deposit targets already-deposited note A.
    let create_input_b = user
        .new_open_note_with_generated_random(:recipient, :token_addr, index: 2);
    let create_actions_b = create_input_b.into_server_actions(:user);
    let mut actions: Array<ServerAction> = create_actions_b.into();
    actions.append(ServerAction::Invoke(invoke_input));
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_ALREADY_DEPOSITED);
    // Balances unchanged (revert).
    assert_eq!(input_token.balance_of(address: privacy_address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor_addr), (swap_amount * 3).into());
    assert_eq!(input_token.balance_of(address: amm_address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: privacy_address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: executor_addr), Zero::zero());
    assert_eq!(output_token.balance_of(address: amm_address), (swap_amount * 3).into());

    // Catch TOKEN_MISMATCH: open note is for input token; executor deposits output token.
    let create_note_input = user
        .new_open_note_with_generated_random(
            :recipient, token_addr: input_token.contract_address(), index: Zero::zero(),
        );
    user.cheat_create_open_note(:create_note_input);
    let (note_id, _) = user.compute_open_note(:create_note_input);

    let invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        :note_id,
    );
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: errors::TOKEN_MISMATCH);
    // Balances unchanged (revert).
    assert_eq!(input_token.balance_of(address: privacy_address), Zero::zero());
    assert_eq!(input_token.balance_of(address: executor_addr), (swap_amount * 3).into());
    assert_eq!(input_token.balance_of(address: amm_address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: privacy_address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: executor_addr), Zero::zero());
    assert_eq!(output_token.balance_of(address: amm_address), (swap_amount * 3).into());
}

#[test]
fn test_undeposited_open_notes() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let mut user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    let echo_executor = test.privacy.echo_executor;
    let token_addr = token.contract_address();

    user.set_viewing_key_e2e();
    user.open_channel_e2e(recipient: user, index: 0);
    user.open_subchannel_e2e(recipient: user, :token_addr, index: 0);

    // Catch UNDEPOSITED_OPEN_NOTES: EmitOpenNoteCreated without a matching Invoke deposit.
    let create_input = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, index: 0);
    let actions = create_input.into_server_actions(:user);
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::UNDEPOSITED_OPEN_NOTES);

    // Catch TOO_MANY_OPEN_NOTES_DEPOSITED: Invoke deposit without a matching EmitOpenNoteCreated.
    let create_input = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, index: 0);
    user.cheat_create_open_note(create_note_input: create_input);
    let (note_id, _) = user.compute_open_note(create_note_input: create_input);
    token.supply(address: echo_executor, :amount);
    token.approve(owner: echo_executor, spender: test.privacy.address, amount: amount.into());
    let deposit = OpenNoteDeposit { note_id, token: token_addr, amount };
    let actions = test
        .privacy
        .invoke_external_echo_deposits([deposit].span())
        .into_server_actions();
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(
        :result, expected_error: internal_errors::TOO_MANY_OPEN_NOTES_DEPOSITED,
    );
}

#[test]
fn test_apply_invoke_vesu_deposit() {
    let mut test: Test = Default::default();
    let vesu = test.deploy_vesu_components();
    let deposit_amount = constants::DEFAULT_AMOUNT;
    let anonymizer_addr = vesu.lending_anonymizer;
    let vault_addr = vesu.vault;

    // Create an open note with lending_anonymizer.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let recipient = user;
    user.open_channel_e2e(:recipient, index: 0);
    user.open_subchannel_e2e(:recipient, token_addr: vault_addr, index: 0);
    let create_note_input = user
        .new_open_note_with_generated_random(:recipient, token_addr: vault_addr, index: 0);
    let (note_id, _) = user.compute_open_note(:create_note_input);

    // Fund lending anonymizer with underlying tokens.
    vesu.underlying_token.supply(address: anonymizer_addr, amount: deposit_amount);

    // Verify balances before deposit.
    assert_eq!(vesu.underlying_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(vesu.underlying_token.balance_of(address: anonymizer_addr), deposit_amount.into());
    assert_eq!(vesu.vault_balance_of(address: test.privacy.address), 0);
    assert_eq!(vesu.vault_balance_of(address: anonymizer_addr), 0);
    assert_eq!(vesu.vault_balance_of(address: vault_addr), 0);

    // Spy on events before executing.
    let mut spy = spy_events();

    // Execute the invoke action.
    let invoke_input = vesu.invoke_vesu_deposit_input(assets: deposit_amount, :note_id);
    let mut server_actions: Array<ServerAction> = create_note_input
        .into_server_actions(:user)
        .into();
    server_actions.append(ServerAction::Invoke(invoke_input));
    test.privacy.apply_actions(server_actions.span());

    // Verify open note was filled with deposit amount.
    let filled_note = test.privacy.get_note(:note_id);
    let (filled_salt, filled_amount) = unpack(packed_value: filled_note.packed_value);
    assert_eq!(filled_salt, OPEN_NOTE_SALT);
    assert_eq!(filled_amount, deposit_amount);
    assert_eq!(filled_note.token, vault_addr);

    // Verify balances after deposit.
    assert_eq!(vesu.underlying_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(vesu.underlying_token.balance_of(address: anonymizer_addr), 0);
    assert_eq!(vesu.underlying_token.balance_of(address: vault_addr), deposit_amount.into());
    assert_eq!(vesu.vault_balance_of(address: test.privacy.address), deposit_amount.into());
    assert_eq!(vesu.vault_balance_of(address: anonymizer_addr), 0);
    assert_eq!(vesu.vault_balance_of(address: vault_addr), 0);

    // Verify OpenNoteCreated and OpenNoteDeposited events emitted.
    let expected_event_created = events::OpenNoteCreated {
        enc_recipient_addr: encrypt_user_addr(
            ephemeral_secret: create_note_input.random,
            auditor_public_key: test.privacy.get_auditor_public_key(),
            user_addr: recipient.address,
        ),
        token: vault_addr,
        note_id,
    };
    let expected_event_deposit = events::OpenNoteDeposited {
        depositor: anonymizer_addr, token: vault_addr, note_id, amount: deposit_amount,
    };
    let emitted_events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(emitted_events.len(), 2);
    assert_expected_event_emitted(
        spied_event: emitted_events[0],
        expected_event: expected_event_created,
        expected_event_selector: @selector!("OpenNoteCreated"),
        expected_event_name: "OpenNoteCreated",
    );
    assert_expected_event_emitted(
        spied_event: emitted_events[1],
        expected_event: expected_event_deposit,
        expected_event_selector: @selector!("OpenNoteDeposited"),
        expected_event_name: "OpenNoteDeposited",
    );
}


#[test]
fn test_apply_invoke_vesu_withdraw() {
    let mut test: Test = Default::default();
    let vesu = test.deploy_vesu_components();
    let deposit_amount = constants::DEFAULT_AMOUNT;
    let anonymizer_addr = vesu.lending_anonymizer;
    let vault_addr = vesu.vault;
    let underlying_token_addr = vesu.underlying_token.contract_address();

    // Create an open note with lending_anonymizer.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let recipient = user;
    user.open_channel_e2e(:recipient, index: 0);
    user.open_subchannel_e2e(:recipient, token_addr: vault_addr, index: 0);
    let create_note_input = user
        .new_open_note_with_generated_random(:recipient, token_addr: vault_addr, index: 0);
    let (note_id, _) = user.compute_open_note(:create_note_input);

    // Fund lending anonymizer with underlying tokens.
    vesu.underlying_token.supply(address: anonymizer_addr, amount: deposit_amount);

    // Deposit before withdraw.
    let invoke_input = vesu.invoke_vesu_deposit_input(assets: deposit_amount, :note_id);
    let mut server_actions: Array<ServerAction> = create_note_input
        .into_server_actions(:user)
        .into();
    server_actions.append(ServerAction::Invoke(invoke_input));
    test.privacy.apply_actions(server_actions.span());

    // Verify balances before withdraw.
    assert_eq!(vesu.underlying_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(vesu.underlying_token.balance_of(address: anonymizer_addr), 0);
    assert_eq!(vesu.underlying_token.balance_of(address: vault_addr), deposit_amount.into());
    assert_eq!(vesu.vault_balance_of(address: test.privacy.address), deposit_amount.into());
    assert_eq!(vesu.vault_balance_of(address: anonymizer_addr), 0);
    assert_eq!(vesu.vault_balance_of(address: vault_addr), 0);

    // Create open note with lending_anonymizer for the withdraw.
    user.open_subchannel_e2e(:recipient, token_addr: underlying_token_addr, index: 1);
    let create_note_input = user
        .new_open_note_with_generated_random(
            :recipient, token_addr: underlying_token_addr, index: 0,
        );
    let (note_id, _) = user.compute_open_note(:create_note_input);

    // Withdraw vault to anonymizer contract.
    user
        .withdraw_and_use_note_e2e(
            to_addr: anonymizer_addr,
            token_addr: vault_addr,
            amount: deposit_amount,
            channel_key: user.compute_channel_key(recipient: user),
            index: 0,
        );

    // Create Invoke input for withdraw.
    let invoke_input = vesu.invoke_vesu_withdraw_input(assets: deposit_amount, :note_id);

    // Spy on events before executing.
    let mut spy = spy_events();

    // Execute the invoke action.
    let mut server_actions: Array<ServerAction> = create_note_input
        .into_server_actions(:user)
        .into();
    server_actions.append(ServerAction::Invoke(invoke_input));
    test.privacy.apply_actions(server_actions.span());

    // Verify open note was filled with deposit amount.
    let filled_note = test.privacy.get_note(:note_id);
    let (filled_salt, filled_amount) = unpack(packed_value: filled_note.packed_value);
    assert_eq!(filled_salt, OPEN_NOTE_SALT);
    assert_eq!(filled_amount, deposit_amount);
    assert_eq!(filled_note.token, underlying_token_addr);

    // Verify balances after withdraw.
    assert_eq!(
        vesu.underlying_token.balance_of(address: test.privacy.address), deposit_amount.into(),
    );
    assert_eq!(vesu.underlying_token.balance_of(address: anonymizer_addr), 0);
    assert_eq!(vesu.underlying_token.balance_of(address: vault_addr), 0);
    assert_eq!(vesu.vault_balance_of(address: test.privacy.address), 0);
    assert_eq!(vesu.vault_balance_of(address: anonymizer_addr), 0);
    assert_eq!(vesu.vault_balance_of(address: vault_addr), 0);

    // Verify OpenNoteCreated and OpenNoteDeposited events emitted.
    let expected_event_created = events::OpenNoteCreated {
        enc_recipient_addr: encrypt_user_addr(
            ephemeral_secret: create_note_input.random,
            auditor_public_key: test.privacy.get_auditor_public_key(),
            user_addr: recipient.address,
        ),
        token: underlying_token_addr,
        note_id,
    };
    let expected_event_deposit = events::OpenNoteDeposited {
        depositor: anonymizer_addr, token: underlying_token_addr, note_id, amount: deposit_amount,
    };
    let emitted_events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(emitted_events.len(), 2);
    assert_expected_event_emitted(
        spied_event: emitted_events[0],
        expected_event: expected_event_created,
        expected_event_selector: @selector!("OpenNoteCreated"),
        expected_event_name: "OpenNoteCreated",
    );
    assert_expected_event_emitted(
        spied_event: emitted_events[1],
        expected_event: expected_event_deposit,
        expected_event_selector: @selector!("OpenNoteDeposited"),
        expected_event_name: "OpenNoteDeposited",
    );
}

#[test]
fn test_apply_invoke_vesu_assertions() {
    let mut test: Test = Default::default();
    let vesu = test.deploy_vesu_components();
    let amount = constants::DEFAULT_AMOUNT;
    let anonymizer_addr = vesu.lending_anonymizer;
    let vault_addr = vesu.vault;

    // Create an open note with lending_anonymizer.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let recipient = user;
    user.open_channel_e2e(:recipient, index: 0);
    user.open_subchannel_e2e(:recipient, token_addr: vault_addr, index: 0);
    let create_note_input = user
        .new_open_note_with_generated_random(:recipient, token_addr: vault_addr, index: 0);
    let create_actions = create_note_input.into_server_actions(:user);
    let (note_id, _) = user.compute_open_note(:create_note_input);

    // Base valid invoke input (will be modified for each error case).
    let valid_invoke_input_deposit = vesu.invoke_vesu_deposit_input(assets: amount, :note_id);
    let valid_invoke_input_withdraw = vesu.invoke_vesu_withdraw_input(assets: amount, :note_id);

    // Catch ZERO_IN_TOKEN
    let mut vesu_zero_vault = vesu;
    vesu_zero_vault.vault = Zero::zero();
    let zero_in_token_invoke_input = vesu_zero_vault
        .invoke_vesu_withdraw_input(assets: amount, :note_id);
    let mut server_actions: Array<ServerAction> = create_actions.into();
    server_actions.append(ServerAction::Invoke(zero_in_token_invoke_input));
    let result = test.privacy.safe_apply_actions(server_actions.span());
    assert_panic_with_felt_error(:result, expected_error: vesu_errors::ZERO_IN_TOKEN);

    // Catch ZERO_OUT_TOKEN
    let zero_out_token_invoke_input = vesu_zero_vault
        .invoke_vesu_deposit_input(assets: amount, :note_id);
    let mut server_actions: Array<ServerAction> = create_actions.into();
    server_actions.append(ServerAction::Invoke(zero_out_token_invoke_input));
    let result = test.privacy.safe_apply_actions(server_actions.span());
    assert_panic_with_felt_error(:result, expected_error: vesu_errors::ZERO_OUT_TOKEN);

    // Catch ZERO_ASSETS
    let zero_assets_invoke_input = vesu.invoke_vesu_deposit_input(assets: 0, :note_id);
    let mut server_actions: Array<ServerAction> = create_actions.into();
    server_actions.append(ServerAction::Invoke(zero_assets_invoke_input));
    let result = test.privacy.safe_apply_actions(server_actions.span());
    assert_panic_with_felt_error(:result, expected_error: vesu_errors::ZERO_ASSETS);

    // Catch TOKENS_EQUAL
    let mut vesu_tokens_equal = vesu;
    vesu_tokens_equal.vault = vesu.underlying_token.contract_address();
    let tokens_equal_invoke_input = vesu_tokens_equal
        .invoke_vesu_deposit_input(assets: amount, :note_id);
    let mut server_actions: Array<ServerAction> = create_actions.into();
    server_actions.append(ServerAction::Invoke(tokens_equal_invoke_input));
    let result = test.privacy.safe_apply_actions(server_actions.span());
    assert_panic_with_felt_error(:result, expected_error: vesu_errors::TOKENS_EQUAL);

    // Catch INSUFFICIENT_BALANCE (ERC20).
    let mut server_actions: Array<ServerAction> = create_actions.into();
    server_actions.append(ServerAction::Invoke(valid_invoke_input_deposit));
    let result = test.privacy.safe_apply_actions(server_actions.span());
    assert_panic_with_felt_error(:result, expected_error: 'ERC20: insufficient balance');
    let mut server_actions: Array<ServerAction> = create_actions.into();
    server_actions.append(ServerAction::Invoke(valid_invoke_input_withdraw));
    let result = test.privacy.safe_apply_actions(server_actions.span());
    assert_panic_with_felt_error(:result, expected_error: 'ERC20: insufficient balance');

    // Catch ZERO_OUT_AMOUNT
    let noop_vault = deploy_mock_vesu_vault_noop(
        underlying_token: vesu.underlying_token.contract_address(),
    );
    let mut vesu_noop = vesu;
    vesu_noop.vault = noop_vault;
    vesu_noop.underlying_token.supply(address: anonymizer_addr, :amount);
    let noop_invoke_input = vesu_noop.invoke_vesu_deposit_input(assets: amount, :note_id);
    let mut server_actions: Array<ServerAction> = create_actions.into();
    server_actions.append(ServerAction::Invoke(noop_invoke_input));
    let result = test.privacy.safe_apply_actions(server_actions.span());
    assert_panic_with_felt_error(:result, expected_error: vesu_errors::ZERO_OUT_AMOUNT);
    let noop_invoke_input = vesu_noop.invoke_vesu_withdraw_input(assets: amount, :note_id);
    let mut server_actions: Array<ServerAction> = create_actions.into();
    server_actions.append(ServerAction::Invoke(noop_invoke_input));
    let result = test.privacy.safe_apply_actions(server_actions.span());
    assert_panic_with_felt_error(:result, expected_error: vesu_errors::ZERO_OUT_AMOUNT);
}

#[test]
fn test_apply_invoke_vesu_open_note_deposit_assertions() {
    let mut test: Test = Default::default();
    let vesu = test.deploy_vesu_components();
    let amount = constants::DEFAULT_AMOUNT;
    let anonymizer_addr = vesu.lending_anonymizer;
    let vault_addr = vesu.vault;
    let token_addr = vesu.underlying_token.contract_address();

    // Setup user with viewing key and subchannel.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let recipient = user;
    user.open_channel_e2e(:recipient, index: 0);
    user.open_subchannel_e2e(:recipient, token_addr: vault_addr, index: 0);

    // Fund lending anonymizer with underlying (enough for multiple attempts).
    vesu.underlying_token.supply(address: anonymizer_addr, amount: amount * 4);

    // Catch NOTE_NOT_FOUND
    let nonexistent_note_id = 'NONEXISTENT_NOTE';
    let invoke_input = vesu.invoke_vesu_deposit_input(assets: amount, note_id: nonexistent_note_id);
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    // Catch NOTE_NOT_OPEN
    let create_note_input = user
        .new_enc_note_with_generated_salt(
            recipient: user, token_addr: vault_addr, :amount, index: 0,
        );
    user.cheat_create_enc_note_e2e(:create_note_input);
    let (note_id_enc, _) = user.compute_enc_note(:create_note_input);

    let invoke_input = vesu.invoke_vesu_deposit_input(assets: amount, note_id: note_id_enc);
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_OPEN);

    // Catch NOTE_ALREADY_DEPOSITED
    let create_note_input = user
        .new_open_note_with_generated_random(:recipient, token_addr: vault_addr, index: 1);
    let (note_id_filled, _) = user.compute_open_note(:create_note_input);
    // First deposit succeeds.
    let invoke_input = vesu.invoke_vesu_deposit_input(assets: amount, note_id: note_id_filled);
    let mut server_actions: Array<ServerAction> = create_note_input
        .into_server_actions(:user)
        .into();
    server_actions.append(ServerAction::Invoke(invoke_input));
    test.privacy.apply_actions(server_actions.span());
    // Second deposit to same note should fail (create other open note but try to deposit to the
    // first one).
    let create_note_input = user
        .new_open_note_with_generated_random(:recipient, token_addr: vault_addr, index: 2);
    let mut server_actions: Array<ServerAction> = create_note_input
        .into_server_actions(:user)
        .into();
    server_actions.append(ServerAction::Invoke(invoke_input));
    let result = test.privacy.safe_apply_actions(server_actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_ALREADY_DEPOSITED);

    // Catch TOKEN_MISMATCH: open note is for underlying; anonymizer deposits share token (vault).
    user.open_subchannel_e2e(:recipient, :token_addr, index: 1);
    let create_note_input = user
        .new_open_note_with_generated_random(:recipient, :token_addr, index: 0);
    let (note_id_token_mismatch, _) = user.compute_open_note(:create_note_input);

    let invoke_input = vesu
        .invoke_vesu_deposit_input(assets: amount, note_id: note_id_token_mismatch);
    let mut server_actions: Array<ServerAction> = create_note_input
        .into_server_actions(:user)
        .into();
    server_actions.append(ServerAction::Invoke(invoke_input));
    let result = test.privacy.safe_apply_actions(server_actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::TOKEN_MISMATCH);
}

#[test]
fn test_apply_actions_with_fee() {
    let test: Test = Default::default();
    let fee_amount = constants::DEFAULT_FEE_AMOUNT;
    let fee_collector = constants::DEFAULT_FEE_COLLECTOR;
    test.privacy.set_fee_collector(:fee_collector);
    test.privacy.set_fee_amount(:fee_amount);
    let strk_token = test.privacy.strk_token;
    assert!(fee_amount.is_non_zero());
    let privacy_address = test.privacy.address;
    let caller: ContractAddress = 'CALLER'.try_into().unwrap();

    // Verify all balances before apply_actions.
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    // Call apply_actions — the anonymizer auto-funds the caller.
    test.privacy.apply_actions_as(actions: [].span(), :caller);

    // Verify balances after apply_actions: fee moved from caller to fee_collector.
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector), fee_amount.into());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());
}

#[test]
fn test_apply_actions_with_zero_fee() {
    let test: Test = Default::default();
    let strk_token = test.privacy.strk_token;
    let privacy_address = test.privacy.address;
    let caller: ContractAddress = 'NO_STRK_CALLER'.try_into().unwrap();
    let fee_collector = test.privacy.get_fee_collector();
    assert!(test.privacy.get_fee_amount().is_zero());

    // Verify all balances before apply_actions.
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    // apply_actions should succeed without STRK funding.
    test.privacy.safe_apply_actions_as_unfunded(actions: [].span(), :caller).unwrap();

    // Verify no balances changed.
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());
}

#[test]
fn test_apply_actions_with_fee_assertions() {
    let test: Test = Default::default();
    let fee_amount = constants::DEFAULT_FEE_AMOUNT;
    let fee_collector = constants::DEFAULT_FEE_COLLECTOR;
    test.privacy.set_fee_collector(:fee_collector);
    test.privacy.set_fee_amount(:fee_amount);
    let strk_token = test.privacy.strk_token;
    let privacy_address = test.privacy.address;
    let caller: ContractAddress = 'BROKE_CALLER'.try_into().unwrap();
    assert!(fee_amount.is_non_zero());

    // Verify all balances before apply_actions.
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    // Caller has no STRK balance — use unfunded variant to skip auto-funding.
    let result = test.privacy.safe_apply_actions_as_unfunded(actions: [].span(), :caller);
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());

    // Verify no balances changed.
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    // Give caller STRK balance but do NOT approve.
    strk_token.supply(address: caller, amount: fee_amount);

    // Verify all balances before apply_actions.
    assert_eq!(strk_token.balance_of(address: caller), fee_amount.into());
    assert_eq!(strk_token.balance_of(address: fee_collector), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    let result = test.privacy.safe_apply_actions_as_unfunded(actions: [].span(), :caller);
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_ALLOWANCE.describe());

    // Verify no balances changed.
    assert_eq!(strk_token.balance_of(address: caller), fee_amount.into());
    assert_eq!(strk_token.balance_of(address: fee_collector), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());
}

/// Open note funded with a large amount, recipient splits it into enc notes for two others.
/// Verifies the holder can spend an open note and fan out its value to multiple recipients.
#[test]
fn test_open_note_split_into_multiple_recipients() {
    let mut test: Test = Default::default();
    let mut user_a = test.new_user();
    let mut user_b = test.new_user();
    let mut user_c = test.new_user();
    let mut user_d = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount_total = constants::DEFAULT_AMOUNT * 3;
    let amount_c = constants::DEFAULT_AMOUNT;
    let amount_d = amount_total - amount_c;

    // Register all users and set up channels.
    user_a.set_viewing_key_e2e();
    user_b.set_viewing_key_e2e();
    user_c.set_viewing_key_e2e();
    user_d.set_viewing_key_e2e();
    user_a.open_channel_with_token_e2e(recipient: user_b, :token_addr, outgoing_channel_index: 0);
    user_b.open_channel_with_token_e2e(recipient: user_c, :token_addr, outgoing_channel_index: 0);
    user_b.open_channel_with_token_e2e(recipient: user_d, :token_addr, outgoing_channel_index: 1);

    // user_a creates open note for user_b and deposits via echo executor.
    let open_note_input = user_a
        .new_open_note_with_generated_random(recipient: user_b, :token_addr, index: 0);
    let open_note_id = user_a
        .create_and_deposit_to_open_note_e2e(
            create_note_input: open_note_input, amount: amount_total, :token,
        );
    let (_, filled_amount) = unpack(
        packed_value: test.privacy.get_note(note_id: open_note_id).packed_value,
    );
    assert_eq!(filled_amount, amount_total);
    assert_eq!(token.balance_of(address: test.privacy.address), amount_total.into());

    // user_b uses the open note and splits its value into enc notes for user_c and user_d.
    let channel_key_a_b = user_a.compute_channel_key(recipient: user_b);
    let use_open_note = UseNoteInput { channel_key: channel_key_a_b, token: token_addr, index: 0 };
    let create_for_c = user_b
        .new_enc_note_with_generated_salt(
            recipient: user_c, :token_addr, amount: amount_c, index: 0,
        );
    let create_for_d = user_b
        .new_enc_note_with_generated_salt(
            recipient: user_d, :token_addr, amount: amount_d, index: 0,
        );
    let actions = user_b
        .transfer(
            notes_to_use: [use_open_note].span(),
            notes_to_create: [create_for_c, create_for_d].span(),
        );
    test.privacy.apply_actions(:actions);
    assert_eq!(token.balance_of(address: test.privacy.address), amount_total.into());

    let nullifier = user_b.compute_nullifier(sender: user_a, :token_addr, index: 0);
    assert!(test.privacy.nullifier_exists(:nullifier));
    let (note_id_c, note_c) = user_b.compute_enc_note(create_note_input: create_for_c);
    let (note_id_d, note_d) = user_b.compute_enc_note(create_note_input: create_for_d);
    assert_eq!(test.privacy.get_note(note_id: note_id_c), note_c);
    assert_eq!(test.privacy.get_note(note_id: note_id_d), note_d);
    assert_eq!(token.balance_of(address: test.privacy.address), amount_total.into());
}

/// Two open notes funded by different depositors; both recipients transfer to a common
/// recipient. Verifies independent depositors can fund separate notes and recipients spend them.
#[test]
fn test_open_note_multiple_depositors() {
    let mut test: Test = Default::default();
    let mut user_a = test.new_user();
    let mut user_b = test.new_user();
    let mut user_c = test.new_user();
    let mut user_d = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = constants::DEFAULT_AMOUNT;

    // Register all users and set up channels.
    user_a.set_viewing_key_e2e();
    user_b.set_viewing_key_e2e();
    user_c.set_viewing_key_e2e();
    user_d.set_viewing_key_e2e();
    user_a.open_channel_with_token_e2e(recipient: user_b, :token_addr, outgoing_channel_index: 0);
    user_a.open_channel_with_token_e2e(recipient: user_c, :token_addr, outgoing_channel_index: 1);
    user_b.open_channel_with_token_e2e(recipient: user_d, :token_addr, outgoing_channel_index: 0);
    user_c.open_channel_with_token_e2e(recipient: user_d, :token_addr, outgoing_channel_index: 0);

    // user_a creates two open notes for user_b and user_c, each deposited via echo executor.
    let open_note_b_input = user_a
        .new_open_note_with_generated_random(recipient: user_b, :token_addr, index: 0);
    let open_note_c_input = user_a
        .new_open_note_with_generated_random(recipient: user_c, :token_addr, index: 0);
    let note_id_b = user_a
        .create_and_deposit_to_open_note_e2e(create_note_input: open_note_b_input, :amount, :token);
    let note_id_c = user_a
        .create_and_deposit_to_open_note_e2e(create_note_input: open_note_c_input, :amount, :token);
    let (_, amount_b_filled) = unpack(
        packed_value: test.privacy.get_note(note_id: note_id_b).packed_value,
    );
    let (_, amount_c_filled) = unpack(
        packed_value: test.privacy.get_note(note_id: note_id_c).packed_value,
    );
    assert_eq!(amount_b_filled, amount);
    assert_eq!(amount_c_filled, amount);
    assert_eq!(token.balance_of(address: test.privacy.address), (2 * amount).into());

    // Both user_b and user_c transfer their open note value to user_d.
    let channel_key_a_b = user_a.compute_channel_key(recipient: user_b);
    let channel_key_a_c = user_a.compute_channel_key(recipient: user_c);
    let create_b_to_d = user_b
        .new_enc_note_with_generated_salt(recipient: user_d, :token_addr, :amount, index: 0);
    let create_c_to_d = user_c
        .new_enc_note_with_generated_salt(recipient: user_d, :token_addr, :amount, index: 0);
    let actions_b = user_b
        .transfer(
            notes_to_use: [
                UseNoteInput { channel_key: channel_key_a_b, token: token_addr, index: 0 }
            ]
                .span(),
            notes_to_create: [create_b_to_d].span(),
        );
    test.privacy.apply_actions(actions: actions_b);
    assert_eq!(token.balance_of(address: test.privacy.address), (2 * amount).into());
    let actions_c = user_c
        .transfer(
            notes_to_use: [
                UseNoteInput { channel_key: channel_key_a_c, token: token_addr, index: 0 }
            ]
                .span(),
            notes_to_create: [create_c_to_d].span(),
        );
    test.privacy.apply_actions(actions: actions_c);
    assert_eq!(token.balance_of(address: test.privacy.address), (2 * amount).into());

    let nullifier_b = user_b.compute_nullifier(sender: user_a, :token_addr, index: 0);
    let nullifier_c = user_c.compute_nullifier(sender: user_a, :token_addr, index: 0);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_b));
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_c));
    let (note_id_b_to_d, note_b_to_d) = user_b.compute_enc_note(create_note_input: create_b_to_d);
    let (note_id_c_to_d, note_c_to_d) = user_c.compute_enc_note(create_note_input: create_c_to_d);
    assert_eq!(test.privacy.get_note(note_id: note_id_b_to_d), note_b_to_d);
    assert_eq!(test.privacy.get_note(note_id: note_id_c_to_d), note_c_to_d);
    assert_eq!(token.balance_of(address: test.privacy.address), (2 * amount).into());
}

/// Same depositor funds multiple open notes for different recipients.
/// Verifies a single depositor can sequentially fund several open notes.
#[test]
fn test_same_depositor_funds_multiple_open_notes() {
    let mut test: Test = Default::default();
    let mut user_a = test.new_user();
    let mut user_b = test.new_user();
    let mut user_c = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount_b = constants::DEFAULT_AMOUNT;
    let amount_c = constants::DEFAULT_AMOUNT * 2;

    // Register users and open channels for user_a to each recipient.
    user_a.set_viewing_key_e2e();
    user_b.set_viewing_key_e2e();
    user_c.set_viewing_key_e2e();
    user_a.open_channel_with_token_e2e(recipient: user_b, :token_addr, outgoing_channel_index: 0);
    user_a.open_channel_with_token_e2e(recipient: user_c, :token_addr, outgoing_channel_index: 1);

    // user_a creates two open notes both funded by the echo executor.
    let open_note_b_input = user_a
        .new_open_note_with_generated_random(recipient: user_b, :token_addr, index: 0);
    let open_note_c_input = user_a
        .new_open_note_with_generated_random(recipient: user_c, :token_addr, index: 0);
    let note_id_b = user_a
        .create_and_deposit_to_open_note_e2e(
            create_note_input: open_note_b_input, amount: amount_b, :token,
        );
    assert_eq!(token.balance_of(address: test.privacy.address), amount_b.into());
    let note_id_c = user_a
        .create_and_deposit_to_open_note_e2e(
            create_note_input: open_note_c_input, amount: amount_c, :token,
        );
    assert_eq!(token.balance_of(address: test.privacy.address), (amount_b + amount_c).into());

    let filled_b = test.privacy.get_note(note_id: note_id_b);
    let filled_c = test.privacy.get_note(note_id: note_id_c);
    let (_, stored_amount_b) = unpack(packed_value: filled_b.packed_value);
    let (_, stored_amount_c) = unpack(packed_value: filled_c.packed_value);
    assert_eq!(stored_amount_b, amount_b);
    assert_eq!(stored_amount_c, amount_c);
}

// === Screening (mandatory depositor attestation for regular-pool deposits) ===
//
// `apply_actions` screens every regular deposit (`TransferFrom`) against an off-chain attestation
// signed by the configured screener key, bound to the deposit's `from_addr`. These tests drive the
// policy directly via `apply_actions_screened` / `safe_apply_actions_screened` (no auto-attestation
// from the test harness), covering the {deposit, non-deposit} x {Some, None} matrix plus freshness,
// signer, and depositor-binding failures.

#[test]
fn test_deposit_with_valid_screening_passes() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());

    let deposit = [
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user.address, token: token.contract_address(), amount },
        ),
    ]
        .span();
    let attestation = sign_screening_attestation(depositor: user.address, issued_at: 0);
    test
        .privacy
        .apply_actions_screened(
            actions: deposit, screening: Some(attestation), caller: constants::PAYMASTER,
        );

    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
}

#[test]
fn test_deposit_without_screening_fails() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());

    let deposit = [
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user.address, token: token.contract_address(), amount },
        ),
    ]
        .span();
    let result = test
        .privacy
        .safe_apply_actions_screened(
            actions: deposit, screening: None, caller: constants::PAYMASTER,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SCREENING_REQUIRED);
}

#[test]
fn test_UNEXPECTED_SCREENING_fails() {
    let mut test: Test = Default::default();
    let user = test.new_user();

    let attestation = sign_screening_attestation(depositor: user.address, issued_at: 0);
    let result = test
        .privacy
        .safe_apply_actions_screened(
            actions: [].span(), screening: Some(attestation), caller: constants::PAYMASTER,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::UNEXPECTED_SCREENING);
}

#[test]
fn test_non_deposit_without_screening_passes() {
    let mut test: Test = Default::default();
    // No deposit, no attestation: a transfer/withdraw-style tx must pass.
    test
        .privacy
        .apply_actions_screened(
            actions: [].span(), screening: None, caller: constants::PAYMASTER,
        );
}

#[test]
fn test_deposit_wrong_screener_key_fails() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());

    let deposit = [
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user.address, token: token.contract_address(), amount },
        ),
    ]
        .span();
    // Signed by a key the contract was not deployed with.
    let wrong_key = KeyPairTrait::from_secret_key('WRONG_SCREENER_SK');
    let attestation = sign_screening_attestation_with(
        key_pair: wrong_key, depositor: user.address, issued_at: 0,
    );
    let result = test
        .privacy
        .safe_apply_actions_screened(
            actions: deposit, screening: Some(attestation), caller: constants::PAYMASTER,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SCREENING_INVALID_SIGNATURE);
}

#[test]
fn test_deposit_depositor_mismatch_fails() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let depositor = test.new_user();
    let other = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    depositor.increase_token_balance(:token, :amount);
    depositor.approve(:token, amount: amount.into());

    let deposit = [
        ServerAction::TransferFrom(
            TransferFromInput {
                from_addr: depositor.address, token: token.contract_address(), amount,
            },
        ),
    ]
        .span();
    // Attestation signed for a different depositor than the one actually depositing.
    let attestation = sign_screening_attestation(depositor: other.address, issued_at: 0);
    let result = test
        .privacy
        .safe_apply_actions_screened(
            actions: deposit, screening: Some(attestation), caller: constants::PAYMASTER,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::SCREENING_INVALID_SIGNATURE);
}

#[test]
fn test_deposit_stale_screening_fails() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());

    let now = 1_000_u64;
    let deposit = [
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user.address, token: token.contract_address(), amount },
        ),
    ]
        .span();
    // One second past the max age.
    let attestation = sign_screening_attestation(
        depositor: user.address, issued_at: now - DEPOSITOR_VALIDATION_MAX_AGE - 1,
    );
    start_cheat_block_timestamp(test.privacy.address, now);
    let result = test
        .privacy
        .safe_apply_actions_screened(
            actions: deposit, screening: Some(attestation), caller: constants::PAYMASTER,
        );
    stop_cheat_block_timestamp(test.privacy.address);
    assert_panic_with_felt_error(:result, expected_error: errors::SCREENING_EXPIRED);
}

#[test]
fn test_deposit_future_dated_screening_fails() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());

    let now = 1_000_u64;
    let deposit = [
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user.address, token: token.contract_address(), amount },
        ),
    ]
        .span();
    // One second beyond the future-skew tolerance.
    let attestation = sign_screening_attestation(
        depositor: user.address, issued_at: now + DEPOSITOR_VALIDATION_MAX_FUTURE + 1,
    );
    start_cheat_block_timestamp(test.privacy.address, now);
    let result = test
        .privacy
        .safe_apply_actions_screened(
            actions: deposit, screening: Some(attestation), caller: constants::PAYMASTER,
        );
    stop_cheat_block_timestamp(test.privacy.address);
    assert_panic_with_felt_error(:result, expected_error: errors::SCREENING_FUTURE_DATED);
}

#[test]
fn test_deposit_at_max_age_boundary_passes() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());

    let now = 1_000_u64;
    let deposit = [
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user.address, token: token.contract_address(), amount },
        ),
    ]
        .span();
    // Exactly at the max age is still fresh.
    let attestation = sign_screening_attestation(
        depositor: user.address, issued_at: now - DEPOSITOR_VALIDATION_MAX_AGE,
    );
    start_cheat_block_timestamp(test.privacy.address, now);
    test
        .privacy
        .apply_actions_screened(
            actions: deposit, screening: Some(attestation), caller: constants::PAYMASTER,
        );
    stop_cheat_block_timestamp(test.privacy.address);
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
}

#[test]
fn test_deposit_within_future_tolerance_passes() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());

    let now = 1_000_u64;
    let deposit = [
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user.address, token: token.contract_address(), amount },
        ),
    ]
        .span();
    // Dated in the future but within the allowed clock-skew tolerance is still accepted.
    let attestation = sign_screening_attestation(
        depositor: user.address, issued_at: now + DEPOSITOR_VALIDATION_MAX_FUTURE,
    );
    start_cheat_block_timestamp(test.privacy.address, now);
    test
        .privacy
        .apply_actions_screened(
            actions: deposit, screening: Some(attestation), caller: constants::PAYMASTER,
        );
    stop_cheat_block_timestamp(test.privacy.address);
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
}

#[test]
fn test_multiple_deposits_same_depositor_pass() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let user = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    user.increase_token_balance(:token, amount: 2 * amount);
    user.approve(:token, amount: (2 * amount).into());

    let token_addr = token.contract_address();
    let deposits = [
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user.address, token: token_addr, amount },
        ),
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user.address, token: token_addr, amount },
        ),
    ]
        .span();
    // A single attestation covers every deposit by that depositor in the tx.
    let attestation = sign_screening_attestation(depositor: user.address, issued_at: 0);
    test
        .privacy
        .apply_actions_screened(
            actions: deposits, screening: Some(attestation), caller: constants::PAYMASTER,
        );
    assert_eq!(token.balance_of(address: test.privacy.address), (2 * amount).into());
}

#[test]
fn test_apply_actions_rejects_multiple_depositors() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let user_a = test.new_user();
    let user_b = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    user_a.increase_token_balance(:token, :amount);
    user_a.approve(:token, amount: amount.into());
    user_b.increase_token_balance(:token, :amount);
    user_b.approve(:token, amount: amount.into());

    let token_addr = token.contract_address();
    let deposits = [
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user_a.address, token: token_addr, amount },
        ),
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: user_b.address, token: token_addr, amount },
        ),
    ]
        .span();
    let attestation = sign_screening_attestation(depositor: user_a.address, issued_at: 0);
    let result = test
        .privacy
        .safe_apply_actions_screened(
            actions: deposits, screening: Some(attestation), caller: constants::PAYMASTER,
        );
    assert_panic_with_felt_error(:result, expected_error: internal_errors::MULTIPLE_DEPOSITORS);
}

#[test]
fn test_combined_regular_and_open_note_deposits_screened_independently() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = constants::DEFAULT_AMOUNT;
    let echo_executor = test.privacy.echo_executor;

    // Open-note deposit: depositor is the Invoke target (echo_executor), screened by the block
    // list — not by an attestation.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    user.open_channel_with_token_e2e(recipient: user, :token_addr, outgoing_channel_index: 0);
    let create_note_input = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, index: 0);
    token.supply(address: echo_executor, :amount);
    token.approve(owner: echo_executor, spender: test.privacy.address, amount: amount.into());
    let (note_id, open_note_actions) = user
        .create_and_deposit_to_open_note(:create_note_input, :amount);

    // Regular deposit: depositor A, screened by a signed attestation.
    let depositor_a = test.new_user();
    depositor_a.increase_token_balance(:token, :amount);
    depositor_a.approve(:token, amount: amount.into());
    let mut combined: Array<ServerAction> = array![
        ServerAction::TransferFrom(
            TransferFromInput { from_addr: depositor_a.address, token: token_addr, amount },
        ),
    ];
    for action in open_note_actions {
        combined.append(*action);
    }
    let combined = combined.span();
    let attestation = sign_screening_attestation(depositor: depositor_a.address, issued_at: 0);

    // Blocking the open-note depositor rejects the whole tx even though the regular deposit's
    // attestation is valid — the two depositor checks are enforced independently.
    test.privacy.set_open_note_depositor_blocked(depositor: echo_executor, blocked: true);
    let result = test
        .privacy
        .safe_apply_actions_screened(
            actions: combined, screening: Some(attestation), caller: constants::PAYMASTER,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::OPEN_NOTE_DEPOSITOR_BLOCKED);

    // Unblocking lets both deposits land under the same valid attestation.
    test.privacy.set_open_note_depositor_blocked(depositor: echo_executor, blocked: false);
    test
        .privacy
        .apply_actions_screened(
            actions: combined, screening: Some(attestation), caller: constants::PAYMASTER,
        );
    let deposited_note = test.privacy.get_note(:note_id);
    let (salt, stored_amount) = unpack(packed_value: deposited_note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, amount);
    assert_eq!(token.balance_of(address: test.privacy.address), (2 * amount).into());
}
