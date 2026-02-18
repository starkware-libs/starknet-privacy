use core::num::traits::Zero;
use privacy::actions::{
    AppendToVecInput, InvokeInput, ReadAssertInput, ServerAction, TransferFromInput,
    TransferToInput,
};
use privacy::objects::{EncOutgoingChannelInfo, EncPrivateKeyTrait, Note};
use privacy::tests::mock_swap_executor::errors as mock_swap_executor_errors;
use privacy::tests::utils_for_tests::{
    CreateOpenNoteInputIntoServerActionTrait, NoteZero, PrivacyCfgTrait, Test, TestTrait, UserTrait,
    constants, deploy_mock_swap_executor, invoke_mock_swap_executor_input,
};
use privacy::utils::constants::{OPEN_NOTE_SALT, PROOF_VALIDITY_BLOCK_INTERVAL};
use privacy::utils::{ProofFacts, _compute_message_hash, open_note, to_write_once_action, unpacking};
use privacy::{errors, events};
use snforge_std::{EventSpyTrait, EventsFilterTrait, TokenTrait, map_entry_address, spy_events};
use starknet::{ContractAddress, get_block_number};
use starkware_utils::components::pausable::PausableComponent::Errors as PausableErrors;
use starkware_utils::constants::MAX_U128;
use starkware_utils::erc20::erc20_errors::Erc20Error;
use starkware_utils::errors::Describable;
use starkware_utils_testing::test_utils::{
    TokenHelperTrait, advance_block_number_global, assert_expected_event_emitted,
    assert_panic_with_error, assert_panic_with_felt_error,
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
    assert!(enc_private_key.is_all_non_zero());

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
    assert!(enc_private_key.is_all_non_zero());

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
        .compute_enc_outgoing_channel_info(recipient: user, index: 0, salt: Zero::zero());
    assert!(outgoing_channel_id.is_non_zero());
    assert!(enc_outgoing_channel_info.enc_recipient_addr.is_non_zero());

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
        .compute_enc_outgoing_channel_info(recipient: user, index: 0, salt: Zero::zero());
    assert!(outgoing_channel_id.is_non_zero());
    assert!(enc_outgoing_channel_info.enc_recipient_addr.is_non_zero());

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
fn test_apply_append_to_vector() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let (enc_channel_info, _) = test.mock_new_channel();

    // Append channel to vector
    let actions: Array<ServerAction> = array![
        ServerAction::AppendToVec(
            AppendToVecInput { recipient_addr: user.address, enc_channel_info: enc_channel_info },
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
    user
        .open_channel_with_token_e2e(
            recipient: user, :token_addr, outgoing_channel_index: 0, subchannel_index: 0,
        );
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
            TransferToInput {
                to_addr: recipient.address, token: token.contract_address(), amount: amount,
            },
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
            TransferToInput {
                to_addr: recipient.address, token: token.contract_address(), amount: amount,
            },
        ),
    ];
    assert_lt!(token.balance_of(address: test.privacy.address), amount.into());
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());
}

#[test]
fn test_apply_read_assert() {
    let mut test: Test = Default::default();
    let user = test.new_user();

    // Write initial value.
    let storage_address = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let actions = array![to_write_once_action(:storage_address, value: user.public_key)].span();
    test.privacy.apply_actions(actions);

    // Verify value by loading from storage.
    assert_eq!(user.get_public_key(), user.public_key);

    // Verify value by action.
    let actions = array![
        ServerAction::ReadAssert(ReadAssertInput { storage_address, value: user.public_key }),
    ];
    test.privacy.apply_actions(actions.span());
}

#[test]
fn test_apply_read_assert_assertions() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );

    // Catch VALUE_MISMATCH.
    assert_ne!(user.get_public_key(), user.public_key);
    let actions = array![
        ServerAction::ReadAssert(
            ReadAssertInput { storage_address: storage_path_felt, value: user.public_key },
        ),
    ];
    let result = test.privacy.safe_apply_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::VALUE_MISMATCH);
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
    let token = test.mock_new_token();
    let depositor = test.mock_new_depositor();
    let enc_recipient_addr = test.mock_new_enc_address();
    let note_id = 'NOTE_ID';
    let expected_event = events::OpenNoteCreated { enc_recipient_addr, depositor, token, note_id };
    let actions = array![ServerAction::EmitOpenNoteCreated(expected_event)];
    let mut spy = spy_events();
    test.privacy.apply_actions(actions.span());
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        :expected_event,
        expected_event_selector: @selector!("OpenNoteCreated"),
        expected_event_name: "OpenNoteCreated",
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
fn test_apply_actions_assertions() {
    let mut test: Test = Default::default();
    let actions = [].span();
    let proof_facts: ProofFacts = Default::default();

    // Catch EMPTY_PROOF_FACTS (no proof facts cheated).
    let result = test.privacy.safe_apply_actions_without_cheat(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::EMPTY_PROOF_FACTS);

    // Catch PROOF_FACTS_DESERIALIZE_ERROR (non-empty but invalid serialization).
    let invalid_proof_facts = [0x1].span();
    let result = test
        .privacy
        .safe_apply_actions_with_raw_proof_facts(:actions, raw_proof_facts: invalid_proof_facts);
    assert_panic_with_felt_error(:result, expected_error: errors::PROOF_FACTS_DESERIALIZE_ERROR);

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
    let message_hash = _compute_message_hash(:actions, contract_address: test.privacy.address);
    proof_facts_invalid_proof_msg.message_to_l1_hashes = [message_hash, message_hash].span();
    let result = test
        .privacy
        .safe_apply_actions_with_proof_facts(:actions, proof_facts: proof_facts_invalid_proof_msg);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_PROOF_MSG);

    // Catch PROOF_EXPIRED.
    let mut proof_facts_expired = proof_facts;
    proof_facts_expired.base_block_number = get_block_number();
    advance_block_number_global(blocks: PROOF_VALIDITY_BLOCK_INTERVAL + 1);
    let result = test
        .privacy
        .safe_apply_actions_with_proof_facts(:actions, proof_facts: proof_facts_expired);
    assert_panic_with_felt_error(:result, expected_error: errors::PROOF_EXPIRED);

    // Catch INVALID_BASE_BLOCK_NUMBER.
    let mut proof_facts_invalid_base_block_number = proof_facts;
    proof_facts_invalid_base_block_number.base_block_number = get_block_number() + 1;
    let result = test
        .privacy
        .safe_apply_actions_with_proof_facts(
            :actions, proof_facts: proof_facts_invalid_base_block_number,
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_BASE_BLOCK_NUMBER);
}

#[test]
fn test_apply_actions_proof_facts_cheat() {
    let mut test: Test = Default::default();
    let actions = [].span();
    test.privacy.apply_actions(:actions);
}

#[test]
fn test_deposit_to_open_note_paused() {
    let mut test: Test = Default::default();
    let depositor = test.new_user();
    let token_addr = test.mock_new_token();
    test.privacy.pause();
    let result = depositor.safe_deposit_to_open_note(note_id: 1, :token_addr, amount: 1);
    assert_panic_with_felt_error(:result, expected_error: PausableErrors::PAUSED);
}

#[test]
fn test_apply_write_once_open_note() {
    // Test that server correctly writes all open note fields.
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let depositor = test.mock_new_depositor();
    let token_addr = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_addr, outgoing_channel_index: 0, subchannel_index: 0,
        );

    let create_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0, :depositor);
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
    let depositor = test.mock_new_depositor();
    let token_addr = test.mock_new_token();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_addr, outgoing_channel_index: 0, subchannel_index: 0,
        );

    // Create open note first.
    let create_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 0, :depositor);
    user_1.cheat_create_open_note_e2e(:create_note_input);

    // Try to write again - should fail.
    let actions = create_note_input.into_server_actions(user: user_1);
    let result = test.privacy.safe_apply_actions(:actions);
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_deposit_to_open_note() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let mut depositor = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    let token_addr = token.contract_address();

    // Create an open note.
    let create_note_input = depositor
        .new_open_note_with_generated_random(
            recipient: depositor, :token_addr, index: 0, depositor: depositor.address,
        );
    let (note_id, open_note) = depositor.compute_open_note(:create_note_input);

    // Write the open note to storage.
    test.privacy.cheat_create_note(:note_id, note: open_note);

    // Verify note was written.
    let stored_note = test.privacy.get_note(:note_id);
    assert_eq!(stored_note, open_note);

    // Set up depositor with token balance and approval.
    depositor.increase_token_balance(:token, :amount);
    depositor.approve(:token, amount: amount.into());

    // Verify balances before deposit.
    assert_eq!(token.balance_of(address: depositor.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    // Spy on events before executing.
    let mut spy = spy_events();

    // Execute deposit_to_open_note (caller must be the depositor).
    depositor.deposit_to_open_note(:note_id, :token_addr, :amount);

    // Verify note packed_value updated with OPEN_NOTE_SALT and amount.
    let filled_note = test.privacy.get_note(:note_id);
    let (salt, stored_amount) = unpacking(packed_value: filled_note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, amount);
    assert_eq!(filled_note.token, token_addr);
    assert_eq!(filled_note.depositor, depositor.address);

    // Verify tokens transferred.
    assert_eq!(token.balance_of(address: depositor.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    // Verify OpenNoteDeposited event emitted.
    let expected_event = events::OpenNoteDeposited {
        depositor: depositor.address, token: token_addr, note_id, amount,
    };
    let emitted_events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(emitted_events.len(), 1);
    assert_expected_event_emitted(
        spied_event: emitted_events[0],
        :expected_event,
        expected_event_selector: @selector!("OpenNoteDeposited"),
        expected_event_name: "OpenNoteDeposited",
    );
}

#[test]
fn test_deposit_to_open_note_assertions() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let mut user = test.new_user();
    let depositor = test.new_user();
    let other_depositor = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    let token_addr = token.contract_address();

    // Setup: depositor has balance and approval.
    depositor.increase_token_balance(:token, :amount);
    depositor.approve(:token, amount: amount.into());

    // Catch ZERO_NOTE_ID - Try to deposit with zero note_id.
    let result = depositor.safe_deposit_to_open_note(note_id: 0, :token_addr, :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_NOTE_ID);

    // Catch ZERO_TOKEN - Try to deposit with zero token.
    let result = depositor.safe_deposit_to_open_note(note_id: 1, token_addr: Zero::zero(), :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_TOKEN);

    // Catch ZERO_AMOUNT - Try to deposit with zero amount.
    let (some_note_id, _) = test.mock_new_note(:amount);
    let result = depositor.safe_deposit_to_open_note(note_id: some_note_id, :token_addr, amount: 0);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AMOUNT);

    // Catch NOTE_NOT_FOUND - Try to deposit to a note that doesn't exist.
    let (nonexistent_note_id, _) = test.mock_new_note(:amount);
    // Note: mock_new_note returns a note_id but does NOT write it to storage.
    let result = depositor
        .safe_deposit_to_open_note(note_id: nonexistent_note_id, :token_addr, :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    // Catch NOTE_NOT_OPEN - Write an encrypted note (salt >= 2), try to deposit to it.
    let create_note_input = user
        .new_enc_note_with_generated_salt(recipient: user, :token_addr, :amount, index: 0);
    let (note_id_enc, enc_note) = user.compute_enc_note(:create_note_input);
    // Write just the packed_value (encrypted note has zero token and depositor).
    test.privacy.cheat_create_note(note_id: note_id_enc, note: enc_note);

    let result = depositor.safe_deposit_to_open_note(note_id: note_id_enc, :token_addr, :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_OPEN);

    // Catch NOTE_ALREADY_DEPOSITED - Deposit to an open note, then try to deposit again.
    let (note_id_filled, _) = test.mock_new_note(:amount);
    let note = open_note(token: token_addr, depositor: depositor.address);
    test.privacy.cheat_create_note(note_id: note_id_filled, :note);

    // Deposit to the open note first time.
    depositor.deposit_to_open_note(note_id: note_id_filled, :token_addr, :amount);

    // Now try to deposit again - should fail with NOTE_ALREADY_DEPOSITED.
    // Need to add more balance and approval for second attempt.
    depositor.increase_token_balance(:token, :amount);
    depositor.approve(:token, amount: amount.into());

    let result = depositor.safe_deposit_to_open_note(note_id: note_id_filled, :token_addr, :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_ALREADY_DEPOSITED);

    // Catch TOKEN_MISMATCH.
    let (note_id, _) = test.mock_new_note(:amount);
    let note = open_note(token: token_addr, depositor: depositor.address);
    test.privacy.cheat_create_note(:note_id, :note);
    let result = depositor
        .safe_deposit_to_open_note(:note_id, token_addr: test.mock_new_token(), :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::TOKEN_MISMATCH);

    // Catch CALLER_NOT_DEPOSITOR - Create open note with depositor A, caller is depositor B.
    let (note_id_mismatch, _) = test.mock_new_note(:amount);
    let open_note_a = open_note(token: token_addr, depositor: depositor.address);
    test.privacy.cheat_create_note(note_id: note_id_mismatch, note: open_note_a);

    // Try to deposit with other_depositor as caller instead of depositor.
    other_depositor.increase_token_balance(:token, :amount);
    other_depositor.approve(:token, amount: amount.into());

    let result = other_depositor
        .safe_deposit_to_open_note(note_id: note_id_mismatch, :token_addr, :amount);
    assert_panic_with_felt_error(:result, expected_error: errors::CALLER_NOT_DEPOSITOR);
}

#[test]
fn test_deposit_to_open_note_transfer_assertions() {
    let mut test: Test = Default::default();
    let token = test.new_token();
    let mut user = test.new_user();
    let depositor = test.new_user();
    let amount = constants::DEFAULT_AMOUNT;
    let token_addr = token.contract_address();

    // Create an open note.
    let create_note_input = user
        .new_open_note_with_generated_random(
            recipient: user, :token_addr, index: 0, depositor: depositor.address,
        );
    let (note_id, open_note) = user.compute_open_note(:create_note_input);
    test.privacy.cheat_create_note(:note_id, note: open_note);

    // Test 1: INSUFFICIENT_BALANCE - Depositor has no tokens.
    let result = depositor.safe_deposit_to_open_note(:note_id, :token_addr, :amount);
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());

    // Test 2: INSUFFICIENT_ALLOWANCE - Depositor has tokens but no approval.
    // Reuse the same note since Test 1 failed and didn't modify the note state.
    depositor.increase_token_balance(:token, :amount);
    // Note: NOT calling approve here.

    let result = depositor.safe_deposit_to_open_note(:note_id, :token_addr, :amount);
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

    // Create an open note with swap_executor as depositor.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let recipient = user;
    user.open_channel_e2e(:recipient, index: 0);
    user.open_subchannel_e2e(:recipient, token_addr: output_token.contract_address(), index: 0);
    let create_note_input = user
        .new_open_note_with_generated_random(
            :recipient,
            token_addr: output_token.contract_address(),
            index: 0,
            depositor: executor_addr,
        );
    user.cheat_create_open_note_e2e(:create_note_input);
    let (note_id, _) = user.compute_open_note(:create_note_input);

    // Verify open note was created with zero amount.
    let initial_note = test.privacy.get_note(:note_id);
    let (initial_salt, initial_amount) = unpacking(packed_value: initial_note.packed_value);
    assert_eq!(initial_salt, OPEN_NOTE_SALT);
    assert_eq!(initial_amount, 0);

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

    // Execute the invoke action.
    test.privacy.apply_actions([ServerAction::Invoke(invoke_input)].span());

    // Verify open note was filled with swap amount.
    let filled_note = test.privacy.get_note(:note_id);
    let (filled_salt, filled_amount) = unpacking(packed_value: filled_note.packed_value);
    assert_eq!(filled_salt, OPEN_NOTE_SALT);
    assert_eq!(filled_amount, swap_amount);
    assert_eq!(filled_note.token, output_token.contract_address());
    assert_eq!(filled_note.depositor, executor_addr);

    // Verify balances after swap.
    // Input tokens: swap_executor -> AMM (via swap).
    assert_eq!(input_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(input_token.balance_of(address: executor_addr), 0);
    assert_eq!(input_token.balance_of(address: amm_address), swap_amount.into());
    // Output tokens: AMM -> swap_executor -> privacy (via deposit).
    assert_eq!(output_token.balance_of(address: test.privacy.address), swap_amount.into());
    assert_eq!(output_token.balance_of(address: executor_addr), 0);
    assert_eq!(output_token.balance_of(address: amm_address), 0);

    // Verify OpenNoteDeposited event emitted.
    let expected_event = events::OpenNoteDeposited {
        depositor: executor_addr,
        token: output_token.contract_address(),
        note_id,
        amount: swap_amount,
    };
    let emitted_events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(emitted_events.len(), 1);
    assert_expected_event_emitted(
        spied_event: emitted_events[0],
        :expected_event,
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

    // Create an open note with swap_executor as depositor.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let recipient = user;
    user.open_channel_e2e(:recipient, index: 0);
    user.open_subchannel_e2e(:recipient, token_addr: output_token.contract_address(), index: 0);
    let create_note_input = user
        .new_open_note_with_generated_random(
            :recipient,
            token_addr: output_token.contract_address(),
            index: 0,
            depositor: executor_addr,
        );
    user.cheat_create_open_note_e2e(:create_note_input);
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

    // Catch ZERO_NOTE_ID
    let zero_note_id_invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        note_id: Zero::zero(),
    );
    let result = test
        .privacy
        .safe_apply_actions([ServerAction::Invoke(zero_note_id_invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: mock_swap_executor_errors::ZERO_NOTE_ID);

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
    // TODO: Test token balances after snforge reverts work.
    let mut test: Test = Default::default();
    let input_token = test.new_token();
    let output_token = test.new_token();
    let swap_amount = constants::DEFAULT_AMOUNT;
    let executor_addr = test.privacy.swap_executor.address;
    let amm_address = test.privacy.mock_amm;
    let token_addr = output_token.contract_address();

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

    // Catch NOTE_NOT_FOUND
    let nonexistent_note_id = 'NONEXISTENT_NOTE';
    let invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        note_id: nonexistent_note_id,
    );
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_FOUND);

    // Catch NOTE_NOT_OPEN
    let create_note_input = user
        .new_enc_note_with_generated_salt(
            recipient: user, :token_addr, amount: swap_amount, index: 0,
        );
    user.cheat_create_enc_note_e2e(:create_note_input);
    let (note_id_enc, _) = user.compute_enc_note(:create_note_input);

    let invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        note_id: note_id_enc,
    );
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_NOT_OPEN);

    // Catch NOTE_ALREADY_DEPOSITED
    let create_note_input = user
        .new_open_note_with_generated_random(
            :recipient, :token_addr, index: 1, depositor: executor_addr,
        );
    user.cheat_create_open_note_e2e(:create_note_input);
    let (note_id_filled, _) = user.compute_open_note(:create_note_input);

    let invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        note_id: note_id_filled,
    );

    // First swap succeeds.
    test.privacy.apply_actions([ServerAction::Invoke(invoke_input)].span());

    // Second swap to same note should fail.
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: errors::NOTE_ALREADY_DEPOSITED);

    // Catch CALLER_NOT_DEPOSITOR
    let wrong_depositor: ContractAddress = 'WRONG_DEPOSITOR'.try_into().unwrap();
    let create_note_input = user
        .new_open_note_with_generated_random(
            :recipient, :token_addr, index: 2, depositor: wrong_depositor,
        );
    user.cheat_create_open_note_e2e(:create_note_input);
    let (note_id_mismatch, _) = user.compute_open_note(:create_note_input);

    let invoke_input = invoke_mock_swap_executor_input(
        swap_executor: executor_addr,
        in_token: input_token.contract_address(),
        out_token: output_token.contract_address(),
        in_amount: swap_amount,
        note_id: note_id_mismatch,
    );
    let result = test.privacy.safe_apply_actions([ServerAction::Invoke(invoke_input)].span());
    assert_panic_with_felt_error(:result, expected_error: errors::CALLER_NOT_DEPOSITOR);

    // Catch TOKEN_MISMATCH: open note is for input token; executor deposits output token.
    let create_note_input = user
        .new_open_note_with_generated_random(
            :recipient,
            token_addr: input_token.contract_address(),
            index: 0,
            depositor: executor_addr,
        );
    user.cheat_create_open_note_e2e(:create_note_input);
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
}

#[test]
fn test_apply_actions_with_fee() {
    let test: Test = Default::default();
    let strk_token = test.privacy.strk_token;
    let fee_amount = test.privacy.get_fee_amount();
    assert!(fee_amount.is_non_zero());
    let fee_collector = test.privacy.get_fee_collector();
    let privacy_address = test.privacy.address;
    let caller: ContractAddress = 'CALLER'.try_into().unwrap();

    // Verify all balances before apply_actions.
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    // Call apply_actions — the helper auto-funds the caller.
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

    // Disable the fee.
    test.privacy.set_fee(fee_amount: 0, fee_collector: Zero::zero());

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
    let strk_token = test.privacy.strk_token;
    let fee_collector = test.privacy.get_fee_collector();
    let privacy_address = test.privacy.address;
    let caller: ContractAddress = 'BROKE_CALLER'.try_into().unwrap();
    let fee_amount = test.privacy.get_fee_amount();
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
