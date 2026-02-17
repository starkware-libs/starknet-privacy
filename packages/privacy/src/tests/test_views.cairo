use core::num::traits::Zero;
use privacy::objects::{EncOutgoingChannelInfo, EncSubchannelInfo};
use privacy::privacy::Privacy;
use privacy::tests::utils_for_tests::constants::DEFAULT_AMOUNT;
use privacy::tests::utils_for_tests::{NoteZero, PrivacyCfgTrait, Test, TestTrait, UserTrait};
use privacy::utils::constants::OPEN_NOTE_SALT;
use privacy::utils::unpacking;
use snforge_std::TokenTrait;
use starkware_utils::components::replaceability::interface::{
    IReplaceableDispatcher, IReplaceableDispatcherTrait,
};
use starkware_utils::components::roles::interface::{IRolesDispatcher, IRolesDispatcherTrait};
use starkware_utils_testing::test_utils::assert_panic_with_error;


#[test]
fn test_constructor() {
    let mut test: Test = Default::default();
    // Test compliance public key.
    assert_eq!(test.privacy.get_compliance_public_key(), test.compliance.public_key);
    // Test roles.
    let contract_roles = IRolesDispatcher { contract_address: test.privacy.address };
    assert!(contract_roles.is_governance_admin(account: test.privacy.roles.governance_admin));
    assert!(contract_roles.is_security_admin(account: test.privacy.roles.governance_admin));
    let user = test.new_user();
    assert!(!contract_roles.is_governance_admin(account: user.address));
    assert!(!contract_roles.is_security_admin(account: user.address));
    // Test replaceability.
    let contract_replaceability = IReplaceableDispatcher { contract_address: test.privacy.address };
    assert_eq!(contract_replaceability.get_upgrade_delay(), Zero::zero());
}

#[test]
#[should_panic(expected: 'ZERO_COMPLIANCE_PUBLIC_KEY')]
fn test_constructor_assertions() {
    let mut state = Privacy::contract_state_for_testing();
    Privacy::constructor(
        ref state,
        governance_admin: 'GOVERNANCE_ADMIN'.try_into().unwrap(),
        compliance_public_key: Zero::zero(),
    );
}

#[test]
fn test_get_compliance_public_key() {
    let mut test: Test = Default::default();
    assert_eq!(test.privacy.get_compliance_public_key(), test.compliance.public_key);
}

#[test]
fn test_channel_exists() {
    let mut test: Test = Default::default();
    let user = test.new_user();
    let recipient_addr = user.address;
    let (enc_channel_info, channel_marker) = test.mock_new_channel();
    assert_eq!(test.privacy.channel_exists(:channel_marker), false);
    test.privacy.cheat_open_channel(:recipient_addr, :enc_channel_info, :channel_marker);
    assert_eq!(test.privacy.channel_exists(:channel_marker), true);
    let (_, channel_marker) = test.mock_new_channel();
    assert_eq!(test.privacy.channel_exists(:channel_marker), false);
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
    user.open_channel_e2e(recipient: user, index: 0);
    assert_eq!(user.get_num_of_channels(), 1);
    // After opening a second channel.
    let mut different_user = test.new_user();
    different_user.set_viewing_key_e2e();
    different_user.open_channel_e2e(recipient: user, index: 0);
    assert_eq!(user.get_num_of_channels(), 2);
    assert_eq!(different_user.get_num_of_channels(), 0);
}

#[test]
fn test_get_channel_info() {
    let mut test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let (channel_1_user_1, channel_marker_1_user_1) = test.mock_new_channel();
    let (channel_2_user_1, channel_marker_2_user_1) = test.mock_new_channel();
    let (channel_1_user_2, channel_marker_1_user_2) = test.mock_new_channel();
    test
        .privacy
        .cheat_open_channel(
            recipient_addr: user_1.address,
            enc_channel_info: channel_1_user_1,
            channel_marker: channel_marker_1_user_1,
        );
    test
        .privacy
        .cheat_open_channel(
            recipient_addr: user_1.address,
            enc_channel_info: channel_2_user_1,
            channel_marker: channel_marker_2_user_1,
        );
    test
        .privacy
        .cheat_open_channel(
            recipient_addr: user_2.address,
            enc_channel_info: channel_1_user_2,
            channel_marker: channel_marker_1_user_2,
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

    let (enc_channel_info, channel_marker) = test.mock_new_channel();
    test
        .privacy
        .cheat_open_channel(recipient_addr: user.address, :enc_channel_info, :channel_marker);

    let result = user.safe_get_channel_info(channel_index: 0);
    assert!(result.is_ok());
    let result = user.safe_get_channel_info(channel_index: 1);
    assert_panic_with_error(:result, expected_error: "Index out of bounds");
}

#[test]
fn test_get_outgoing_channel_info() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let outgoing_channel_id_1 = user_1.compute_outgoing_channel_id(index: 0);
    let outgoing_channel_id_2 = user_1.compute_outgoing_channel_id(index: 1);
    let enc_outgoing_channel_info_1 = user_1
        .compute_enc_outgoing_channel_info(recipient: user_1, index: 0, salt: Zero::zero());
    let enc_outgoing_channel_info_2 = user_1
        .compute_enc_outgoing_channel_info(recipient: user_2, index: 1, salt: Zero::zero());
    assert_ne!(outgoing_channel_id_1, outgoing_channel_id_2);
    assert_ne!(enc_outgoing_channel_info_1, enc_outgoing_channel_info_2);
    assert_eq!(
        test.privacy.get_outgoing_channel_info(outgoing_channel_id: outgoing_channel_id_1),
        EncOutgoingChannelInfo { salt: Zero::zero(), enc_recipient_addr: Zero::zero() },
    );
    assert_eq!(
        test.privacy.get_outgoing_channel_info(outgoing_channel_id: outgoing_channel_id_2),
        EncOutgoingChannelInfo { salt: Zero::zero(), enc_recipient_addr: Zero::zero() },
    );
    let (_, salt_channel_1) = user_1.open_channel_e2e(recipient: user_1, index: 0);
    let enc_outgoing_channel_info_1 = user_1
        .compute_enc_outgoing_channel_info(recipient: user_1, index: 0, salt: salt_channel_1);
    assert_eq!(
        test.privacy.get_outgoing_channel_info(outgoing_channel_id: outgoing_channel_id_1),
        enc_outgoing_channel_info_1,
    );
    assert_eq!(
        test.privacy.get_outgoing_channel_info(outgoing_channel_id: outgoing_channel_id_2),
        EncOutgoingChannelInfo { salt: Zero::zero(), enc_recipient_addr: Zero::zero() },
    );
    let (_, salt_channel_2) = user_1.open_channel_e2e(recipient: user_2, index: 1);
    let enc_outgoing_channel_info_2 = user_1
        .compute_enc_outgoing_channel_info(recipient: user_2, index: 1, salt: salt_channel_2);
    assert_ne!(enc_outgoing_channel_info_1, enc_outgoing_channel_info_2);
    assert_eq!(
        test.privacy.get_outgoing_channel_info(outgoing_channel_id: outgoing_channel_id_1),
        enc_outgoing_channel_info_1,
    );
    assert_eq!(
        test.privacy.get_outgoing_channel_info(outgoing_channel_id: outgoing_channel_id_2),
        enc_outgoing_channel_info_2,
    );
}

#[test]
fn test_get_note() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let mut depositor = test.new_user();
    let amount = DEFAULT_AMOUNT;
    user_1
        .open_channel_with_token_e2e(
            recipient: user_2, :token_addr, outgoing_channel_index: 0, subchannel_index: 0,
        );

    // Create and verify encrypted note.
    let enc_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, index: 0);
    user_1.cheat_create_enc_note_e2e(create_note_input: enc_note_input);
    let (enc_note_id, expected_enc_note) = user_1
        .compute_enc_note(create_note_input: enc_note_input);
    assert_eq!(test.privacy.get_note(note_id: enc_note_id), expected_enc_note);

    // Create and verify empty open note.
    let open_note_input = user_1
        .new_open_note_with_generated_random(
            recipient: user_2, :token_addr, index: 1, depositor: depositor.address,
        );
    user_1.cheat_create_open_note_e2e(create_note_input: open_note_input);
    let (open_note_id, expected_open_note) = user_1
        .compute_open_note(create_note_input: open_note_input);
    assert_eq!(test.privacy.get_note(note_id: open_note_id), expected_open_note);

    // Deposit to the existing open note and verify.
    depositor.fund_and_deposit_to_open_note(:token, note_id: open_note_id, :amount);
    let filled_note = test.privacy.get_note(note_id: open_note_id);
    let (salt, stored_amount) = unpacking(packed_value: filled_note.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, amount);
    assert_eq!(filled_note.token, token_addr);
    assert_eq!(filled_note.depositor, depositor.address);
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
    let token_addr = test.mock_new_token();
    let subchannel_marker = user_1.compute_subchannel_marker(recipient: user_2, :token_addr);
    assert_eq!(test.privacy.subchannel_exists(:subchannel_marker), false);
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    user_1.open_subchannel_e2e(recipient: user_2, :token_addr, index: 0);
    assert_eq!(test.privacy.subchannel_exists(:subchannel_marker), true);
}

#[test]
fn test_get_subchannel_info() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_addr = test.mock_new_token();
    let subchannel_id = user_1.compute_subchannel_id(recipient: user_2, index: 0);
    assert_eq!(
        test.privacy.get_subchannel_info(:subchannel_id),
        EncSubchannelInfo { salt: Zero::zero(), enc_token: Zero::zero() },
    );
    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);
    let salt = user_1.open_subchannel_e2e(recipient: user_2, :token_addr, index: 0);
    let expected_subchannel_info = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_addr, index: 0, :salt);
    assert!(expected_subchannel_info.enc_token.is_non_zero());
    assert_eq!(test.privacy.get_subchannel_info(:subchannel_id), expected_subchannel_info);
}

#[test]
fn test_get_enc_private_key() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    // Before registration.
    let enc_private_key = user.get_enc_private_key();
    assert_eq!(enc_private_key.ephemeral_pubkey, Zero::zero());
    assert_eq!(enc_private_key.enc_private_key, Zero::zero());
    // After registration.
    let random = user.set_viewing_key_e2e();
    let expected_enc_private_key_1 = user.compute_enc_private_key(:random);
    assert_eq!(user.get_enc_private_key(), expected_enc_private_key_1);
}
use privacy::actions::{
    ClientAction, CreateEncNoteInput, CreateOpenNoteInput, DepositInput, OpenChannelInput,
    OpenSubchannelInput, SetViewingKeyInput, WithdrawInput,
};
use privacy::hashes::{compute_channel_key, hash};
use privacy::utils::constants::TWO_POW_120;
use privacy::utils::derive_public_key;
use starknet::ContractAddress;

#[test]
fn test_prepare_tx() {
    let mut test: Test = Default::default();
    let STRK: u128 = 1000000000000000000; // 10^18

    // Account 1.
    println!("--------------------------------");
    println!("Account 1");
    let acc_1_addr: ContractAddress =
        0x041c9dbe8ab9b414fa0ec4d22b7a41d80a3911b77a2c9c819ce949faa5edb9f9
        .try_into()
        .unwrap();
    let acc_1_private_key = 0x254055e37555fd981daf35700e046e42980f4e041d7aaec4886c0c1a46a07;
    let acc_1_viewing_private_key = acc_1_private_key - 1;
    let acc_1_public_key = derive_public_key(acc_1_private_key);
    let acc_1_viewing_public_key = derive_public_key(acc_1_viewing_private_key);
    assert_eq!(
        acc_1_public_key,
        0x1b9bdc063c1972b8a251c2ba0d25851185e64d2ffc318a675cd450844415df2,
        "INVALID_ACC_1_PUBLIC_KEY",
    );
    println!("acc_1_addr: {:?}", acc_1_addr);
    println!("acc_1_private_key: {}", acc_1_private_key);
    println!("acc_1_public_key: {}", acc_1_public_key);
    println!("acc_1_viewing_private_key: {}", acc_1_viewing_private_key);
    println!("acc_1_viewing_public_key: {}", acc_1_viewing_public_key);

    // Account 4.
    println!("--------------------------------");
    println!("Account 4");
    let acc_2_addr: ContractAddress =
        0x0042f3d0b459a7c1dde5879ac3137b553ffcee22da85ceadf05190555835f647
        .try_into()
        .unwrap();
    let acc_2_private_key = 0x3ab21bbef6577ed8e8cf3e4a5c212362c5d16938c23f84be45c0ab20d99f36;
    let acc_2_viewing_private_key = acc_2_private_key - 1;
    let acc_2_public_key = derive_public_key(acc_2_private_key);
    let acc_2_viewing_public_key = derive_public_key(acc_2_viewing_private_key);
    assert_eq!(
        acc_2_public_key,
        0x6d94865c72bd5545aa8308313fb8f2d652cda32d58d6a7227d593a6d8017175,
        "INVALID_ACC_2_PUBLIC_KEY",
    );
    println!("acc_2_addr: {:?}", acc_2_addr);
    println!("acc_2_private_key: {}", acc_2_private_key);
    println!("acc_2_public_key: {}", acc_2_public_key);
    println!("acc_2_viewing_private_key: {}", acc_2_viewing_private_key);
    println!("acc_2_viewing_public_key: {}", acc_2_viewing_public_key);

    // Tokens.
    // strk is TestToken2.
    let strk: ContractAddress = 0x207e3746cf01e4aa10419992a84ae4e2d43ff58bd730b17a7fc164520e2c6cc
        .try_into()
        .unwrap();
    let test_token_1: ContractAddress =
        0x7b19e89252b1ee5d7ff07a0e0e278b16b058f322053f799469b969e31b82969
        .try_into()
        .unwrap();
    println!("--------------------------------");
    println!("Tokens");
    println!("STRK: {:?}", strk);
    println!("TestToken1: {:?}", test_token_1);

    // Account 1 register tx.
    println!("--------------------------------");
    println!("Account 1 register tx");
    let acc_1_register_random = 0x5076e60998cf053bdb3cfe0f3fc97b02ead281d08fc30ccd51258522eebf908;
    println!("acc_1_register_random: {}", acc_1_register_random);
    let client_actions = [
        ClientAction::SetViewingKey(SetViewingKeyInput { random: acc_1_register_random })
    ]
        .span();
    println!("client_actions: {:?}", client_actions);
    let user_addr = acc_1_addr;
    let user_private_key = acc_1_viewing_private_key;
    println!("================================================");
    println!(
        "Arguments: {:?}, {:?}, array!{:?}.span()", user_addr, user_private_key, client_actions,
    );
    println!("================================================");
    let server_actions = test.privacy.execute_view(:user_addr, :user_private_key, :client_actions);
    println!("server_actions: {:?}", server_actions);
    test.privacy.apply_actions(actions: server_actions);

    // Account 2 big tx.
    println!("--------------------------------");
    println!("Account 2 big tx");
    let acc_2_random = hash([acc_2_addr.into(), acc_2_viewing_private_key].span());
    let acc_2_salt = hash([acc_2_addr.into(), acc_2_viewing_public_key].span());
    println!("acc_2_random: {:?}", acc_2_random);
    println!("acc_2_salt: {:?}", acc_2_salt);
    // Register.
    let register = ClientAction::SetViewingKey(SetViewingKeyInput { random: acc_2_random });
    // Open channel.
    let open_self_channel = ClientAction::OpenChannel(
        OpenChannelInput {
            recipient_addr: acc_2_addr,
            recipient_public_key: acc_2_viewing_public_key,
            index: 0,
            random: acc_2_random,
            salt: acc_2_salt,
        },
    );
    let open_acc_1_channel = ClientAction::OpenChannel(
        OpenChannelInput {
            recipient_addr: acc_1_addr,
            recipient_public_key: acc_1_viewing_public_key,
            index: 1,
            random: acc_2_random,
            salt: acc_2_salt,
        },
    );
    // Open subchannel.
    let self_channel_key = compute_channel_key(
        sender_addr: acc_2_addr,
        sender_private_key: acc_2_viewing_private_key,
        recipient_addr: acc_2_addr,
        recipient_public_key: acc_2_viewing_public_key,
    );
    println!("self_channel_key: {:?}", self_channel_key);
    let open_self_strk_subchannel = ClientAction::OpenSubchannel(
        OpenSubchannelInput {
            recipient_addr: acc_2_addr,
            recipient_public_key: acc_2_viewing_public_key,
            channel_key: self_channel_key,
            index: 0,
            token: strk,
            salt: acc_2_salt,
        },
    );
    let open_self_test_token_1_subchannel = ClientAction::OpenSubchannel(
        OpenSubchannelInput {
            recipient_addr: acc_2_addr,
            recipient_public_key: acc_2_viewing_public_key,
            channel_key: self_channel_key,
            index: 1,
            token: test_token_1,
            salt: acc_2_salt,
        },
    );
    let acc_1_channel_key = compute_channel_key(
        sender_addr: acc_2_addr,
        sender_private_key: acc_2_viewing_private_key,
        recipient_addr: acc_1_addr,
        recipient_public_key: acc_1_viewing_public_key,
    );
    println!("acc_1_channel_key: {:?}", acc_1_channel_key);
    let open_acc_1_strk_subchannel = ClientAction::OpenSubchannel(
        OpenSubchannelInput {
            recipient_addr: acc_1_addr,
            recipient_public_key: acc_1_viewing_public_key,
            channel_key: acc_1_channel_key,
            index: 0,
            token: strk,
            salt: acc_2_salt,
        },
    );
    // Deposit.
    let deposit_1_strk = ClientAction::Deposit(DepositInput { token: strk, amount: 9 * STRK });
    let deposit_2_strk = ClientAction::Deposit(DepositInput { token: strk, amount: STRK });
    let deposit_test_token_1 = ClientAction::Deposit(
        DepositInput { token: test_token_1, amount: STRK / 2 },
    );
    // Create notes.
    let two_pow_120: u256 = TWO_POW_120.into();
    let create_note_salt: u128 = (acc_2_salt.try_into().unwrap() % two_pow_120).try_into().unwrap();
    println!("create_note_salt: {}", create_note_salt);
    let create_self_enc_note_strk_1 = ClientAction::CreateEncNote(
        CreateEncNoteInput {
            recipient_addr: acc_2_addr,
            recipient_public_key: acc_2_viewing_public_key,
            token: strk,
            amount: 2 * STRK,
            index: 0,
            salt: create_note_salt,
        },
    );
    let create_self_open_note_strk = ClientAction::CreateOpenNote(
        CreateOpenNoteInput {
            recipient_addr: acc_2_addr,
            recipient_public_key: acc_2_viewing_public_key,
            token: strk,
            index: 1,
            depositor: acc_2_addr,
            random: acc_2_random,
        },
    );
    let create_self_enc_note_strk_2 = ClientAction::CreateEncNote(
        CreateEncNoteInput {
            recipient_addr: acc_2_addr,
            recipient_public_key: acc_2_viewing_public_key,
            token: strk,
            amount: 5 * STRK,
            index: 2,
            salt: create_note_salt,
        },
    );
    let create_acc_1_enc_note_strk = ClientAction::CreateEncNote(
        CreateEncNoteInput {
            recipient_addr: acc_1_addr,
            recipient_public_key: acc_1_viewing_public_key,
            token: strk,
            amount: 3 * STRK,
            index: 0,
            salt: create_note_salt,
        },
    );
    let create_self_open_note_test_token_1 = ClientAction::CreateOpenNote(
        CreateOpenNoteInput {
            recipient_addr: acc_2_addr,
            recipient_public_key: acc_2_viewing_public_key,
            token: test_token_1,
            index: 0,
            depositor: acc_2_addr,
            random: acc_2_random,
        },
    );
    // Withdraw.
    let withdraw_test_token_1_1 = ClientAction::Withdraw(
        WithdrawInput {
            to_addr: acc_1_addr, token: test_token_1, amount: STRK / 4, random: acc_2_random,
        },
    );
    let withdraw_test_token_1_2 = ClientAction::Withdraw(
        WithdrawInput {
            to_addr: acc_2_addr, token: test_token_1, amount: STRK / 4, random: acc_2_random,
        },
    );
    let client_actions = [
        register, open_self_channel, open_acc_1_channel, open_self_strk_subchannel,
        open_acc_1_strk_subchannel, open_self_test_token_1_subchannel, deposit_1_strk,
        deposit_test_token_1, deposit_2_strk, create_self_enc_note_strk_1,
        create_self_open_note_strk, create_self_open_note_test_token_1, create_acc_1_enc_note_strk,
        create_self_enc_note_strk_2, withdraw_test_token_1_1, withdraw_test_token_1_2,
    ]
        .span();
    println!("client_actions: {:?}", client_actions);
    println!("length of client_actions: {}", client_actions.len());
    let user_addr = acc_2_addr;
    let user_private_key = acc_2_viewing_private_key;
    println!("================================================");

    println!(
        "Arguments: {:?}, {:?}, array!{:?}.span()", user_addr, user_private_key, client_actions,
    );
    println!("================================================");
    let server_actions = test.privacy.execute_view(:user_addr, :user_private_key, :client_actions);
    println!("server_actions: {:?}", server_actions);
}
