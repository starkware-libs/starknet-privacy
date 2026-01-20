use core::num::traits::Zero;
use privacy::actions::{
    AppendToVecInput, ServerAction, TransferFromInput, TransferToInput, VerifyValueInput,
    WriteIfZeroInput,
};
use privacy::errors;
use privacy::tests::utils_for_tests::{
    PrivacyCfgTrait, PrivacyTokenTrait, Test, TestTrait, UserTrait, constants,
};
use snforge_std::{TokenTrait, map_entry_address};
use starkware_utils::components::pausable::PausableComponent::Errors as PausableErrors;
use starkware_utils::components::replaceability::interface::{
    IReplaceableDispatcher, IReplaceableDispatcherTrait,
};
use starkware_utils::components::roles::interface::{IRolesDispatcher, IRolesDispatcherTrait};
use starkware_utils::erc20::erc20_errors::Erc20Error;
use starkware_utils::errors::Describable;
use starkware_utils_testing::test_utils::{
    assert_panic_with_error, assert_panic_with_felt_error, generic_load,
};

// TODO: Different file for Views tests?

#[test]
fn test_constructor() {
    let mut test: Test = Default::default();
    // Test compliance public key.
    assert_eq!(test.privacy.get_compliance_public_key(), test.compliance_public_key);
    // Test roles.
    let contract_roles = IRolesDispatcher { contract_address: test.privacy.address };
    assert!(contract_roles.is_governance_admin(account: test.privacy.governance_admin));
    assert!(contract_roles.is_security_admin(account: test.privacy.governance_admin));
    let user = test.new_user();
    assert!(!contract_roles.is_governance_admin(account: user.address));
    assert!(!contract_roles.is_security_admin(account: user.address));
    // Test replaceability.
    let contract_replaceability = IReplaceableDispatcher { contract_address: test.privacy.address };
    assert_eq!(contract_replaceability.get_upgrade_delay(), Zero::zero());
}

#[test]
fn test_get_compliance_public_key() {
    let mut test: Test = Default::default();
    assert_eq!(test.privacy.get_compliance_public_key(), test.compliance_public_key);
}

#[test]
fn test_channel_exists() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let recipient_addr = user.address;
    let (enc_channel_info, channel_id) = test.mock_new_channel();
    assert_eq!(test.privacy.channel_exists(:channel_id), false);
    test.privacy.cheat_open_channel(:recipient_addr, :enc_channel_info, :channel_id);
    assert_eq!(test.privacy.channel_exists(:channel_id), true);
    let (_, channel_id) = test.mock_new_channel();
    assert_eq!(test.privacy.channel_exists(:channel_id), false);
}

#[test]
fn test_get_num_of_channels() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    // Before registration.
    assert_eq!(user.get_num_of_channels(), 0);
    // After registration.
    user.set_viewing_key_e2e();
    assert_eq!(user.get_num_of_channels(), 0);
    // After opening a channel.
    user.open_channel_e2e(recipient: user);
    assert_eq!(user.get_num_of_channels(), 1);
    // After opening a second channel.
    let mut different_user = test.new_user();
    different_user.set_viewing_key_e2e();
    different_user.open_channel_e2e(recipient: user);
    assert_eq!(user.get_num_of_channels(), 2);
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
        .cheat_open_channel(
            recipient_addr: user_1.address,
            enc_channel_info: channel_1_user_1,
            channel_id: channel_id_1_user_1,
        );
    test
        .privacy
        .cheat_open_channel(
            recipient_addr: user_1.address,
            enc_channel_info: channel_2_user_1,
            channel_id: channel_id_2_user_1,
        );
    test
        .privacy
        .cheat_open_channel(
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
    test.privacy.cheat_open_channel(recipient_addr: user.address, :enc_channel_info, :channel_id);

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
    test.privacy.cheat_create_note(:note);
    assert_eq!(test.privacy.get_note(note_id: note.id), note.enc_amount);
}

#[test]
fn test_nullifier_exists() {
    let mut test: Test = Default::default();
    let nullifier = test.mock_new_nullifier();
    assert_eq!(test.privacy.nullifier_exists(:nullifier), false);
    test.privacy.cheat_use_note(:nullifier);
    assert_eq!(test.privacy.nullifier_exists(:nullifier), true);
}

#[test]
fn test_get_public_key() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    // Don't register the user.
    assert_eq!(user.get_public_key(), Zero::zero());
    // Register the user.
    user.set_viewing_key_e2e();
    assert_eq!(user.get_public_key(), user.public_key);
}

#[test]
fn test_subchannel_exists() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_address = test.mock_new_token();
    let subchannel_id = user_1.compute_subchannel_id(recipient: user_2, :token_address);
    assert_eq!(test.privacy.subchannel_exists(:subchannel_id), false);
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2);
    user_1.open_subchannel_e2e(recipient: user_2, :token_address, index: 0);
    assert_eq!(test.privacy.subchannel_exists(:subchannel_id), true);
}

#[test]
fn test_get_subchannel_info() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_address = test.mock_new_token();
    let subchannel_key = user_1.compute_subchannel_key(recipient: user_2, index: 0);
    assert_eq!(test.privacy.get_subchannel_info(:subchannel_key), Zero::zero());
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2);
    let salt = user_1.open_subchannel_e2e(recipient: user_2, :token_address, index: 0);
    let expected_subchannel_info = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_address, index: 0, :salt);
    assert!(expected_subchannel_info.is_non_zero());
    assert_eq!(test.privacy.get_subchannel_info(:subchannel_key), expected_subchannel_info);
}

#[test]
fn test_get_enc_private_key() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    // Before registration.
    assert_eq!(user.get_enc_private_key(), Zero::zero());
    // After registration.
    let random = user.set_viewing_key_e2e();
    let expected_enc_private_key_1 = user.compute_enc_private_key(:random);
    assert_eq!(user.get_enc_private_key(), expected_enc_private_key_1);
}

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
fn test_execute_write_if_zero() {
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt, value: true.into() },
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt, value: true.into() },
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt, value: user.public_key },
        ),
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt, value: note.enc_amount },
        ),
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt, value: true.into() },
        ),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify nullifier was written.
    assert_eq!(test.privacy.nullifier_exists(:nullifier), true);
}

#[test]
fn test_execute_write_if_zero_assertions() {
    let mut test: Test = Default::default();
    let (_, channel_id) = test.mock_new_channel();
    let (subchannel_id, _, _) = test.mock_new_subchannel();

    // Catch NON_ZERO_VALUE for channel exists.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [channel_id].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt, value: true.into() },
        ),
    ];
    test.privacy.execute_actions(actions.span());
    let current_value: bool = generic_load(
        target: test.privacy.address, storage_address: storage_path_felt,
    );
    assert_eq!(current_value, true);
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);

    // Catch NON_ZERO_VALUE for subchannel_exists.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [subchannel_id].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt, value: true.into() },
        ),
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt, value: note.enc_amount },
        ),
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
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt, value: true.into() },
        ),
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
fn test_execute_write_if_zero_subchannel() {
    let mut test: Test = Default::default();
    let (_, subchannel_key, enc_subchannel_info) = test.mock_new_subchannel();
    assert!(enc_subchannel_info.is_non_zero());

    // Verify subchannel info is zero before writing.
    assert_eq!(test.privacy.get_subchannel_info(:subchannel_key), Zero::zero());

    // Verify subchannel doesn't exist and write.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [subchannel_key].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroInput { storage_address: storage_path_felt, value: enc_subchannel_info },
        ),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify subchannel exists.
    assert_eq!(test.privacy.get_subchannel_info(:subchannel_key), enc_subchannel_info);
}

#[test]
fn test_execute_write_if_zero_subchannel_assertions() {
    let mut test: Test = Default::default();
    let (_, subchannel_key, enc_subchannel_info) = test.mock_new_subchannel();
    assert!(enc_subchannel_info.is_non_zero());

    // Catch NON_ZERO_VALUE.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [subchannel_key].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZeroSubchannel(
            WriteIfZeroInput { storage_address: storage_path_felt, value: enc_subchannel_info },
        ),
    ];
    test.privacy.execute_actions(actions.span());
    let current_value = generic_load(
        target: test.privacy.address, storage_address: storage_path_felt,
    );
    assert_eq!(current_value, enc_subchannel_info);
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::NON_ZERO_VALUE);
}

#[test]
fn test_execute_write_if_zero_private_key() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let enc_private_key = test.mock_new_enc_private_key();
    assert!(enc_private_key.is_non_zero());

    // Verify private key is zero before writing.
    assert_eq!(user.get_enc_private_key(), Zero::zero());

    // Write private key.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [user.address.into()].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZeroPrivateKey(
            WriteIfZeroInput { storage_address: storage_path_felt, value: enc_private_key },
        ),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify private key exists.
    assert_eq!(user.get_enc_private_key(), enc_private_key);
}

#[test]
fn test_execute_write_if_zero_private_key_assertions() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let enc_private_key = test.mock_new_enc_private_key();
    assert!(enc_private_key.is_non_zero());

    // Catch NON_ZERO_VALUE.
    let storage_path_felt = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [user.address.into()].span(),
    );
    let actions: Array<ServerAction> = array![
        ServerAction::WriteIfZeroPrivateKey(
            WriteIfZeroInput { storage_address: storage_path_felt, value: enc_private_key },
        ),
    ];
    test.privacy.execute_actions(actions.span());
    let current_value = generic_load(
        target: test.privacy.address, storage_address: storage_path_felt,
    );
    assert_eq!(current_value, enc_private_key);
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
                sender_addr: user.address, token: token.contract_address(), amount: amount,
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
                sender_addr: user.address, token: token.contract_address(), amount: amount,
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
    let user = test.new_user();
    let note = test.mock_new_note(:amount);
    user.increase_token_balance(:token, :amount);
    user.cheat_deposit(:token, :amount, :note);

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
    let actions = array![
        ServerAction::WriteIfZero(
            WriteIfZeroInput { storage_address: storage_path_felt, value: user.public_key },
        ),
    ];
    test.privacy.execute_actions(actions.span());

    // Verify value by loading from storage.
    let current_value = generic_load(
        target: test.privacy.address, storage_address: storage_path_felt,
    );
    assert_eq!(current_value, user.public_key);

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
    let current_value = generic_load(
        target: test.privacy.address, storage_address: storage_path_felt,
    );
    assert_ne!(current_value, user.public_key);
    let actions = array![
        ServerAction::VerifyValue(
            VerifyValueInput { storage_address: storage_path_felt, value: user.public_key },
        ),
    ];
    let result = test.privacy.safe_execute_actions(actions.span());
    assert_panic_with_felt_error(:result, expected_error: errors::VALUE_MISMATCH);
}

#[test]
fn test_execute_actions_paused() {
    let mut test: Test = Default::default();
    test.privacy.pause();
    let result = test.privacy.safe_execute_actions([].span());
    assert_panic_with_felt_error(:result, expected_error: PausableErrors::PAUSED);
}
