use core::num::traits::Zero;
use privacy::objects::{EncOutgoingChannelInfo, EncSubchannelInfo};
use privacy::privacy::Privacy;
use privacy::tests::utils_for_tests::constants::{
    DEFAULT_AMOUNT, DEFAULT_FEE_AMOUNT, DEFAULT_FEE_COLLECTOR, DEFAULT_PROOF_VALIDITY_BLOCKS,
};
use privacy::tests::utils_for_tests::{NoteZero, PrivacyCfgTrait, Test, TestTrait, UserTrait};
use snforge_std::TokenTrait;
use starkware_utils::components::replaceability::interface::{
    IReplaceableDispatcher, IReplaceableDispatcherTrait,
};
use starkware_utils::components::roles::interface::{IRolesDispatcher, IRolesDispatcherTrait};
use starkware_utils_testing::test_utils::assert_panic_with_error;


#[test]
fn test_constructor() {
    let mut test: Test = Default::default();
    // Test auditor public key.
    assert_eq!(test.privacy.get_auditor_public_key(), test.auditor.public_key);
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
    // Test fee amount and collector.
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());
    assert_eq!(test.privacy.get_fee_collector(), Zero::zero());
    // Test proof validity blocks.
    assert_eq!(test.privacy.get_proof_validity_blocks(), DEFAULT_PROOF_VALIDITY_BLOCKS);
    // TODO: Verify constructor events (CompliancePublicKeySet, ProofValidityBlocksSet).
}

#[test]
#[should_panic(expected: 'ZERO_AUDITOR_PUBLIC_KEY')]
fn test_constructor_zero_auditor_public_key() {
    let mut state = Privacy::contract_state_for_testing();
    Privacy::constructor(
        ref state,
        governance_admin: 'GOVERNANCE_ADMIN'.try_into().unwrap(),
        auditor_public_key: Zero::zero(),
        proof_validity_blocks: DEFAULT_PROOF_VALIDITY_BLOCKS,
    );
}

#[test]
#[should_panic(expected: 'ZERO_PROOF_VALIDITY_BLOCKS')]
fn test_constructor_zero_proof_validity_blocks() {
    let mut state = Privacy::contract_state_for_testing();
    Privacy::constructor(
        ref state,
        governance_admin: 'GOVERNANCE_ADMIN'.try_into().unwrap(),
        auditor_public_key: 'AUDITOR_PUBLIC_KEY'.try_into().unwrap(),
        proof_validity_blocks: Zero::zero(),
    );
}

#[test]
fn test_get_auditor_public_key() {
    let mut test: Test = Default::default();
    assert_eq!(test.privacy.get_auditor_public_key(), test.auditor.public_key);
}

#[test]
fn test_get_fee_amount() {
    let mut test: Test = Default::default();
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());
    let fee_amount = DEFAULT_FEE_AMOUNT;
    let fee_collector = DEFAULT_FEE_COLLECTOR;
    test.privacy.set_fee_collector(:fee_collector);
    test.privacy.set_fee_amount(:fee_amount);
    assert_eq!(test.privacy.get_fee_amount(), fee_amount);
}

#[test]
fn test_get_fee_collector() {
    let mut test: Test = Default::default();
    assert_eq!(test.privacy.get_fee_collector(), Zero::zero());
    let fee_collector = DEFAULT_FEE_COLLECTOR;
    test.privacy.set_fee_collector(:fee_collector);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector);
}

#[test]
fn test_get_proof_validity_blocks() {
    let mut test: Test = Default::default();
    assert_eq!(test.privacy.get_proof_validity_blocks(), DEFAULT_PROOF_VALIDITY_BLOCKS);
    let proof_validity_blocks = DEFAULT_PROOF_VALIDITY_BLOCKS + 100;
    test.privacy.set_proof_validity_blocks(:proof_validity_blocks);
    assert_eq!(test.privacy.get_proof_validity_blocks(), proof_validity_blocks);
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
    let amount = DEFAULT_AMOUNT;
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);

    // Create and verify encrypted note.
    let enc_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, index: 0);
    user_1.cheat_create_enc_note_e2e(create_note_input: enc_note_input);
    let (enc_note_id, expected_enc_note) = user_1
        .compute_enc_note(create_note_input: enc_note_input);
    assert_eq!(test.privacy.get_note(note_id: enc_note_id), expected_enc_note);

    // Create and verify empty open note.
    let depositor = test.privacy.echo_executor.address;
    let open_note_input = user_1
        .new_open_note_with_generated_random(recipient: user_2, :token_addr, index: 1, :depositor);
    user_1.cheat_create_open_note_in_storage(create_note_input: open_note_input);
    let (open_note_id, expected_open_note) = user_1
        .compute_open_note(create_note_input: open_note_input);
    assert_eq!(test.privacy.get_note(note_id: open_note_id), expected_open_note);

    // Deposit to the existing open note and verify.
    test.privacy.fund_and_cheat_invoke_echo(:token, note_id: open_note_id, :amount);
    let (_, expected_filled_note) = user_1
        .compute_open_note_with_amount(create_note_input: open_note_input, :amount);
    assert_eq!(test.privacy.get_note(note_id: open_note_id), expected_filled_note);
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
