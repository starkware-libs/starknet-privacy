use core::num::traits::Zero;
use privacy::errors;
use privacy::objects::ServerAction;
use privacy::tests::test_utils::{
    PrivacyCfgTrait, PrivacyTokenTrait, Test, TestTrait, UserTrait, constants,
};
use snforge_std::{TokenTrait, map_entry_address};
use starkware_utils::erc20::erc20_errors::Erc20Error;
use starkware_utils::errors::Describable;
use starkware_utils_testing::test_utils::{
    assert_panic_with_error, assert_panic_with_felt_error, generic_load,
};

#[test]
fn test_channel_exists() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let recipient_addr = user.address;
    let (enc_channel_info, channel_id) = test.mock_new_channel();
    assert_eq!(test.privacy.channel_exists(:channel_id), false);
    test.privacy.mock_open_channel(:recipient_addr, :enc_channel_info, :channel_id);
    assert_eq!(test.privacy.channel_exists(:channel_id), true);
    let (_, channel_id) = test.mock_new_channel();
    assert_eq!(test.privacy.channel_exists(:channel_id), false);
}

#[test]
fn test_get_num_of_channels() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let recipient_addr = user.address;
    // TODO: Test before registeration and after registration.
    assert_eq!(user.get_num_of_channels(), 0);
    let (enc_channel_info, channel_id) = test.mock_new_channel();
    test.privacy.mock_open_channel(:recipient_addr, :enc_channel_info, :channel_id);
    assert_eq!(user.get_num_of_channels(), 1);
    let (enc_channel_info, channel_id) = test.mock_new_channel();
    test.privacy.mock_open_channel(:recipient_addr, :enc_channel_info, :channel_id);
    assert_eq!(user.get_num_of_channels(), 2);
    let different_user = test.new_user();
    assert_eq!(different_user.get_num_of_channels(), 0);
}

#[test]
fn test_get_channel_info() {
    let mut test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let (channel_1_user_1, channel_id_1_user_1) = test.mock_new_channel();
    let (channel_2_user_1, channel_id_2_user_1) = test.mock_new_channel();
    let (channel_1_user_2, channel_id_1_user_2) = test.mock_new_channel();
    test
        .privacy
        .mock_open_channel(
            recipient_addr: user_1.address,
            enc_channel_info: channel_1_user_1,
            channel_id: channel_id_1_user_1,
        );
    test
        .privacy
        .mock_open_channel(
            recipient_addr: user_1.address,
            enc_channel_info: channel_2_user_1,
            channel_id: channel_id_2_user_1,
        );
    test
        .privacy
        .mock_open_channel(
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

    let (enc_channel_info, channel_id) = test.mock_new_channel();
    test.privacy.mock_open_channel(recipient_addr: user.address, :enc_channel_info, :channel_id);

    let result = user.safe_get_channel_info(channel_index: 0);
    assert!(result.is_ok());
    let result = user.safe_get_channel_info(channel_index: 1);
    assert_panic_with_error(:result, expected_error: "Index out of bounds");
}

#[test]
fn test_get_note() {
    let mut test: Test = Default::default();
    let note = test.mock_new_note(amount: constants::DEFAULT_AMOUNT);
    assert_eq!(test.privacy.get_note(note_id: note.id), Zero::zero());
    test.privacy.mock_create_note(:note);
    assert_eq!(test.privacy.get_note(note_id: note.id), note.enc_amount);
}

#[test]
fn test_nullifier_exists() {
    let mut test: Test = Default::default();
    let nullifier = test.mock_new_nullifier();
    assert_eq!(test.privacy.nullifier_exists(:nullifier), false);
    test.privacy.mock_use_note(:nullifier);
    assert_eq!(test.privacy.nullifier_exists(:nullifier), true);
}

#[test]
fn test_get_public_key() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    // Don't register the user.
    assert_eq!(user.get_public_key(), Zero::zero());
    // Register the user.
    user.register_e2e();
    assert_eq!(user.get_public_key(), user.public_key);
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
    user1.register_e2e();

    // Register user2.
    user2.register_e2e();

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
    user1.register_e2e();
    user2.register_e2e();

    // Both should be able to fetch the shared public key.
    assert_eq!(user1.get_public_key(), shared_public_key);
    assert_eq!(user2.get_public_key(), shared_public_key);
}

#[test]
fn test_execute_write_if_zero() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let (_, channel_id) = test.mock_new_channel();

    // Compute storage path felt using contract state.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [channel_id].span(),
    );

    // Verify channel doesn't exist and write.
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZero((storage_path_felt, true.into())),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify channel exists.
    assert!(test.privacy.channel_exists(:channel_id));

    // Verify user is not registered and write public key.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZero((storage_path_felt, user.public_key)),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify public key was written.
    assert_eq!(user.get_public_key(), user.public_key);

    // Verify note doesn't exist and write.
    let note = test.mock_new_note(amount: constants::DEFAULT_AMOUNT);
    let storage_path_felt = map_entry_address(
        map_selector: selector!("notes"), keys: [note.id].span(),
    );
    assert_eq!(test.privacy.get_note(note_id: note.id), Zero::zero());
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZero((storage_path_felt, note.enc_amount)),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify note was written.
    assert_eq!(test.privacy.get_note(note_id: note.id), note.enc_amount);

    // Verify nullifier doesn't exist and write.
    let nullifier = test.mock_new_nullifier();
    let storage_path_felt = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let current_value: bool = generic_load(
        target: test.privacy.address, storage_address: storage_path_felt,
    );
    assert_eq!(current_value, false);
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZero((storage_path_felt, true.into())),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify nullifier was written.
    assert_eq!(test.privacy.nullifier_exists(:nullifier), true);
}

#[test]
fn test_execute_write_if_zero_assertions() {
    let mut test: Test = Default::default();
    let (_, channel_id) = test.mock_new_channel();

    // Catch NON_ZERO_VALUE
    let storage_path_felt = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [channel_id].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZero((storage_path_felt, true.into())),
    ];
    test.privacy.execute_actions(actions.span());
    let current_value: bool = generic_load(
        target: test.privacy.address, storage_address: storage_path_felt,
    );
    assert_eq!(current_value, true);
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Catch NON_ZERO_VALUE for notes.
    let note = test.mock_new_note(amount: constants::DEFAULT_AMOUNT);
    let storage_path_felt = map_entry_address(
        map_selector: selector!("notes"), keys: [note.id].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZero((storage_path_felt, note.enc_amount)),
    ];
    test.privacy.execute_actions(actions.span());
    let current_value: felt252 = generic_load(
        target: test.privacy.address, storage_address: storage_path_felt,
    );
    assert_eq!(current_value, note.enc_amount);
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Catch NON_ZERO_VALUE for nullifiers.
    let nullifier = test.mock_new_nullifier();
    let storage_path_felt = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZero((storage_path_felt, true.into())),
    ];
    test.privacy.execute_actions(actions.span());
    let current_value: bool = generic_load(
        target: test.privacy.address, storage_address: storage_path_felt,
    );
    assert_eq!(current_value, true);
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_write_if_non_zero() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();

    // Set initial public key.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZero((storage_path_felt, user.public_key)),
    ];
    test.privacy.execute_actions(actions.span());
    assert_eq!(user.get_public_key(), user.public_key);

    // Change public key.
    user.new_public_key();
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfNonZero((storage_path_felt, user.public_key)),
    ];
    test.privacy.execute_actions(actions.span());
    assert_eq!(user.get_public_key(), user.public_key);

    // Change public key to zero.
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfNonZero((storage_path_felt, Zero::zero())),
    ];
    test.privacy.execute_actions(actions.span());
    assert_eq!(user.get_public_key(), Zero::zero());
}

#[test]
fn test_execute_write_if_non_zero_assertions() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let storage_path_felt = map_entry_address(
        map_selector: selector!("public_key"), keys: [user.address.into()].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfNonZero((storage_path_felt, user.public_key)),
    ];
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_VALUE);

    // Catch ZERO_VALUE for notes.
    let note = test.mock_new_note(amount: constants::DEFAULT_AMOUNT);
    let storage_path_felt = map_entry_address(
        map_selector: selector!("notes"), keys: [note.id].span(),
    );
    let current_value: felt252 = generic_load(
        target: test.privacy.address, storage_address: storage_path_felt,
    );
    assert_eq!(current_value, Zero::zero());
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfNonZero((storage_path_felt, note.enc_amount)),
    ];
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_VALUE);
}

#[test]
fn test_execute_append_to_vector() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let (enc_channel_info, _) = test.mock_new_channel();

    // Append channel to vector
    let actions: Array<ServerAction> = array![
        ServerAction::AppendToVec((user.address, enc_channel_info)),
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

    token.supply(:user, :amount);
    user.approve(:token, amount: amount.into());

    // Verify balances before transfer.
    assert_eq!(token.balance_of(address: user.address), amount.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());

    // Test transfer_from.
    let actions: Array<ServerAction> = array![
        ServerAction::TransferFrom((user.address, token.contract_address(), amount)),
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
        ServerAction::TransferFrom((user.address, token.contract_address(), amount)),
    ];
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());

    // Catch INSUFFICIENT_ALLOWANCE.
    token.supply(:user, :amount);
    let actions: Array<ServerAction> = array![
        ServerAction::TransferFrom((user.address, token.contract_address(), amount)),
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
    let user = test.new_user();
    let note = test.mock_new_note(:amount);
    token.supply(:user, :amount);
    user.mock_deposit_server(:token, :amount, :note);

    // Verify balances before transfer.
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
    assert_eq!(token.balance_of(address: recipient.address), Zero::zero());

    // Test transfer_to.
    let actions: Array<ServerAction> = array![
        ServerAction::TransferTo((recipient.address, token.contract_address(), amount)),
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
        ServerAction::TransferTo((recipient.address, token.contract_address(), amount)),
    ];
    assert_lt!(token.balance_of(address: test.privacy.address), amount.into());
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());
}
