use core::num::traits::Zero;
use privacy::actions::ServerAction;
use privacy::objects::EncUserAddr;
use privacy::tests::utils_for_tests::{
    AuditorTrait, PrivacyCfgTrait, Test, TestTrait, UserTrait, _decrypt_private_key, constants,
    screener_key_pair,
};
use privacy::utils::{ProofFacts, compute_message_hash, derive_public_key};
use privacy::{errors, events};
use snforge_std::{EventSpyTrait, EventsFilterTrait, TokenTrait, spy_events};
use starknet::{ContractAddress, get_block_number};
use starkware_utils::components::roles::errors::AccessErrors;
use starkware_utils::errors::Describable;
use starkware_utils_testing::test_utils::{
    TokenHelperTrait, advance_block_number_global, assert_expected_event_emitted,
    assert_panic_with_error, assert_panic_with_felt_error, cheat_caller_address_once,
};

#[test]
fn test_set_auditor_public_key() {
    let mut test: Test = Default::default();
    assert_eq!(test.privacy.get_auditor_public_key(), test.auditor.public_key);
    let auditor_public_key_before = test.auditor.public_key;
    let mut spy = spy_events();
    test.replace_auditor_key();
    assert_ne!(test.auditor.public_key, auditor_public_key_before);
    assert_eq!(test.privacy.get_auditor_public_key(), test.auditor.public_key);
    let expected_event = events::AuditorPublicKeySet {
        auditor_public_key: test.auditor.public_key,
    };
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        :expected_event,
        expected_event_selector: @selector!("AuditorPublicKeySet"),
        expected_event_name: "AuditorPublicKeySet",
    );
    // Set the same key again.
    let mut spy = spy_events();
    test.privacy.set_auditor_public_key(auditor_public_key: test.auditor.public_key);
    assert_eq!(test.privacy.get_auditor_public_key(), test.auditor.public_key);
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        :expected_event,
        expected_event_selector: @selector!("AuditorPublicKeySet"),
        expected_event_name: "AuditorPublicKeySet",
    );
}

#[test]
fn test_set_auditor_public_key_assertions() {
    let mut test: Test = Default::default();

    // Catch ONLY_SECURITY_GOVERNOR.
    let result = test
        .privacy
        .safe_set_auditor_public_key(auditor_public_key: test.auditor.public_key);
    assert_panic_with_error(
        :result, expected_error: AccessErrors::ONLY_SECURITY_GOVERNOR.describe(),
    );

    // Catch ZERO_AUDITOR_PUBLIC_KEY.
    cheat_caller_address_once(
        contract_address: test.privacy.address,
        caller_address: test.privacy.roles.security_governor,
    );
    let result = test.privacy.safe_set_auditor_public_key(auditor_public_key: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AUDITOR_PUBLIC_KEY);

    // Catch INVALID_AUDITOR_PUBLIC_KEY (non-zero but not a valid Stark curve point).
    cheat_caller_address_once(
        contract_address: test.privacy.address,
        caller_address: test.privacy.roles.security_governor,
    );
    let result = test.privacy.safe_set_auditor_public_key(auditor_public_key: 5);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_AUDITOR_PUBLIC_KEY);
}

/// Flow test for `set_auditor_public_key`.
/// Rotates the auditor key and verifies registration and withdrawal encryption before and after.
#[test]
fn test_set_auditor_public_key_flow() {
    let mut test: Test = Default::default();
    let old_auditor = test.auditor;
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = 100_u128;

    // First registration uses the initial auditor key.
    user_1.set_viewing_key_e2e();

    // Verify encryption on withdrawal.
    user_1.open_channel_with_token_e2e(recipient: user_1, :token_addr, outgoing_channel_index: 0);
    user_1.deposit_and_create_note_e2e(:token, :amount);
    let channel_key_1 = user_1.compute_channel_key(recipient: user_1);
    let mut withdraw_spy_before = spy_events();
    user_1
        .withdraw_and_use_note_e2e(
            to_addr: user_1.address, :token_addr, :amount, channel_key: channel_key_1, index: 0,
        );
    let withdraw_events_before = withdraw_spy_before
        .get_events()
        .emitted_by(contract_address: test.privacy.address)
        .events;
    assert_eq!(withdraw_events_before.len(), 2);
    let (_, withdraw_event_before) = withdraw_events_before[1];
    let enc_user_addr_before = EncUserAddr {
        auditor_public_key: *withdraw_event_before.data[0],
        ephemeral_pubkey: *withdraw_event_before.data[1],
        enc_user_addr: *withdraw_event_before.data[2],
    };
    assert_eq!(enc_user_addr_before.auditor_public_key, old_auditor.public_key);
    assert_eq!(old_auditor.decrypt_user_addr(enc_user_addr: enc_user_addr_before), user_1.address);

    // Rotate the auditor key and verify new registrations and withdrawals use it.
    test.replace_auditor_key();
    assert_ne!(test.auditor.public_key, old_auditor.public_key);
    assert_eq!(test.privacy.get_auditor_public_key(), test.auditor.public_key);

    user_2.set_viewing_key_e2e();

    // Verify encryption on viewing key before (user 1) and after (user 2).
    let enc_private_key_before = user_1.get_enc_private_key();
    assert_eq!(enc_private_key_before.auditor_public_key, old_auditor.public_key);
    assert_eq!(
        old_auditor.decrypt_private_key(enc_private_key: enc_private_key_before),
        user_1.private_key,
    );
    assert_ne!(
        _decrypt_private_key(
            enc_private_key: enc_private_key_before, auditor_private_key: test.auditor.private_key,
        ),
        user_1.private_key,
    );
    let enc_private_key_after = user_2.get_enc_private_key();
    assert_eq!(enc_private_key_after.auditor_public_key, test.auditor.public_key);
    assert_eq!(
        test.auditor.decrypt_private_key(enc_private_key: enc_private_key_after),
        user_2.private_key,
    );
    assert_ne!(
        _decrypt_private_key(
            enc_private_key: enc_private_key_after, auditor_private_key: old_auditor.private_key,
        ),
        user_2.private_key,
    );

    // Verify encryption on withdrawal.
    user_2.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);
    user_2.deposit_and_create_note_e2e(:token, :amount);
    let channel_key_2 = user_2.compute_channel_key(recipient: user_2);
    let mut withdraw_spy_after = spy_events();
    user_2
        .withdraw_and_use_note_e2e(
            to_addr: user_2.address, :token_addr, :amount, channel_key: channel_key_2, index: 0,
        );
    let withdraw_events_after = withdraw_spy_after
        .get_events()
        .emitted_by(contract_address: test.privacy.address)
        .events;
    assert_eq!(withdraw_events_after.len(), 2);
    let (_, withdraw_event_after) = withdraw_events_after[1];
    let enc_user_addr_after = EncUserAddr {
        auditor_public_key: *withdraw_event_after.data[0],
        ephemeral_pubkey: *withdraw_event_after.data[1],
        enc_user_addr: *withdraw_event_after.data[2],
    };
    assert_eq!(enc_user_addr_after.auditor_public_key, test.auditor.public_key);
    assert_eq!(test.auditor.decrypt_user_addr(enc_user_addr: enc_user_addr_after), user_2.address);
}

#[test]
fn test_set_proof_validity_blocks() {
    let mut test: Test = Default::default();
    let proof_validity_blocks = 1000;
    assert_ne!(test.privacy.get_proof_validity_blocks(), proof_validity_blocks);
    let mut spy = spy_events();
    test.privacy.set_proof_validity_blocks(:proof_validity_blocks);
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    let expected_event = events::ProofValidityBlocksSet { proof_validity_blocks };
    assert_expected_event_emitted(
        spied_event: events[0],
        :expected_event,
        expected_event_selector: @selector!("ProofValidityBlocksSet"),
        expected_event_name: "ProofValidityBlocksSet",
    );
    // Set the same value again.
    let mut spy = spy_events();
    test.privacy.set_proof_validity_blocks(:proof_validity_blocks);
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        :expected_event,
        expected_event_selector: @selector!("ProofValidityBlocksSet"),
        expected_event_name: "ProofValidityBlocksSet",
    );
}

#[test]
fn test_set_proof_validity_blocks_assertions() {
    let mut test: Test = Default::default();

    // Catch ONLY_APP_GOVERNOR.
    let result = test.privacy.safe_set_proof_validity_blocks(proof_validity_blocks: 1);
    assert_panic_with_error(:result, expected_error: AccessErrors::ONLY_APP_GOVERNOR.describe());

    // Catch ZERO_PROOF_VALIDITY_BLOCKS.
    cheat_caller_address_once(
        contract_address: test.privacy.address, caller_address: test.privacy.roles.app_governor,
    );
    let result = test.privacy.safe_set_proof_validity_blocks(proof_validity_blocks: 0);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_PROOF_VALIDITY_BLOCKS);
}

/// Flow test for `set_proof_validity_blocks`.
#[test]
fn test_set_proof_validity_blocks_flow() {
    let mut test: Test = Default::default();
    let actions: Array<ServerAction> = array![];
    let actions = actions.span();
    let message_hash = compute_message_hash(:actions, contract_address: test.privacy.address);

    // Set to 2.
    test.privacy.set_proof_validity_blocks(proof_validity_blocks: 2);
    assert_eq!(test.privacy.get_proof_validity_blocks(), 2);

    // With 2 blocks, a proof aged by 2 is still valid.
    let mut proof_facts: ProofFacts = Default::default();
    proof_facts.message_to_l1_hashes = [message_hash].span();
    proof_facts.base_block_number = get_block_number();
    advance_block_number_global(blocks: 2);
    let result = test.privacy.safe_apply_actions_with_proof_facts(:actions, :proof_facts);
    assert!(result.is_ok());

    // With 2 blocks, a proof aged by 3 is expired.
    advance_block_number_global(blocks: 1);
    let result = test.privacy.safe_apply_actions_with_proof_facts(:actions, :proof_facts);
    assert_panic_with_felt_error(:result, expected_error: errors::PROOF_EXPIRED);

    // Set to 3.
    test.privacy.set_proof_validity_blocks(proof_validity_blocks: 3);
    assert_eq!(test.privacy.get_proof_validity_blocks(), 3);

    // With 3 blocks, proofs aged by 2 and 3 are still valid.
    // proof facts should pass now.
    let result = test.privacy.safe_apply_actions_with_proof_facts(:actions, :proof_facts);
    assert!(result.is_ok());
    // Test 2 and 3 again.
    proof_facts.base_block_number = get_block_number();
    advance_block_number_global(blocks: 2);
    let result = test.privacy.safe_apply_actions_with_proof_facts(:actions, :proof_facts);
    assert!(result.is_ok());
    advance_block_number_global(blocks: 1);
    let result = test.privacy.safe_apply_actions_with_proof_facts(:actions, :proof_facts);
    assert!(result.is_ok());

    // With 3 blocks, a proof aged by 4 is expired.
    advance_block_number_global(blocks: 1);
    let result = test.privacy.safe_apply_actions_with_proof_facts(:actions, :proof_facts);
    assert_panic_with_felt_error(:result, expected_error: errors::PROOF_EXPIRED);
}

#[test]
fn test_set_fee_amount() {
    let test: Test = Default::default();
    let fee_collector: ContractAddress = 'FEE_COLLECTOR_1'.try_into().unwrap();
    let fee_amount_1: u128 = constants::DEFAULT_FEE_AMOUNT;
    let fee_amount_2: u128 = constants::DEFAULT_FEE_AMOUNT + 1;

    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());
    assert_eq!(test.privacy.get_fee_collector(), Zero::zero());

    // Set collector first so we can set a non-zero amount.
    test.privacy.set_fee_collector(:fee_collector);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector);
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());

    test.privacy.set_fee_amount(fee_amount: fee_amount_1);
    assert_eq!(test.privacy.get_fee_amount(), fee_amount_1);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector);

    // Set again.
    test.privacy.set_fee_amount(fee_amount: fee_amount_2);
    assert_eq!(test.privacy.get_fee_amount(), fee_amount_2);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector);

    // Set same amount.
    test.privacy.set_fee_amount(fee_amount: fee_amount_2);
    assert_eq!(test.privacy.get_fee_amount(), fee_amount_2);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector);

    // Set zero amount (collector unchanged).
    test.privacy.set_fee_amount(0);
    assert_eq!(test.privacy.get_fee_amount(), 0);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector);
}

#[test]
fn test_set_fee_collector() {
    let test: Test = Default::default();
    let fee_collector_1: ContractAddress = 'FEE_COLLECTOR_1'.try_into().unwrap();
    let fee_collector_2: ContractAddress = 'FEE_COLLECTOR_2'.try_into().unwrap();

    assert_eq!(test.privacy.get_fee_collector(), Zero::zero());
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());

    test.privacy.set_fee_collector(fee_collector: fee_collector_1);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector_1);
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());

    // Set again.
    test.privacy.set_fee_collector(fee_collector: fee_collector_2);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector_2);
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());

    // Set same collector.
    test.privacy.set_fee_collector(fee_collector: fee_collector_2);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector_2);
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());

    // Set collector to zero (amount already set to zero).
    test.privacy.set_fee_collector(Zero::zero());
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());
    assert_eq!(test.privacy.get_fee_collector(), Zero::zero());
}

#[test]
fn test_set_fee_amount_event() {
    let test: Test = Default::default();
    let fee_amount: u128 = constants::DEFAULT_FEE_AMOUNT;
    let fee_collector: ContractAddress = 'FEE_COLLECTOR_1'.try_into().unwrap();

    test.privacy.set_fee_collector(:fee_collector);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector);
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());

    let mut spy = spy_events();
    test.privacy.set_fee_amount(:fee_amount);
    assert_eq!(test.privacy.get_fee_amount(), fee_amount);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector);
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        expected_event: events::FeeAmountSet { fee_amount },
        expected_event_selector: @selector!("FeeAmountSet"),
        expected_event_name: "FeeAmountSet",
    );

    let mut spy = spy_events();
    test.privacy.set_fee_amount(:fee_amount);
    assert_eq!(test.privacy.get_fee_amount(), fee_amount);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector);
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        expected_event: events::FeeAmountSet { fee_amount },
        expected_event_selector: @selector!("FeeAmountSet"),
        expected_event_name: "FeeAmountSet",
    );
}

#[test]
fn test_set_fee_collector_event() {
    let test: Test = Default::default();
    let fee_collector: ContractAddress = 'FEE_COLLECTOR_1'.try_into().unwrap();

    let mut spy = spy_events();
    test.privacy.set_fee_collector(:fee_collector);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector);
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        expected_event: events::FeeCollectorSet { fee_collector },
        expected_event_selector: @selector!("FeeCollectorSet"),
        expected_event_name: "FeeCollectorSet",
    );

    let mut spy = spy_events();
    test.privacy.set_fee_collector(:fee_collector);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector);
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        expected_event: events::FeeCollectorSet { fee_collector },
        expected_event_selector: @selector!("FeeCollectorSet"),
        expected_event_name: "FeeCollectorSet",
    );
}

#[test]
fn test_set_fee_amount_assertions() {
    let test: Test = Default::default();

    let result = test.privacy.safe_set_fee_amount(fee_amount: Zero::zero());
    assert_panic_with_error(:result, expected_error: AccessErrors::ONLY_APP_GOVERNOR.describe());

    cheat_caller_address_once(
        contract_address: test.privacy.address, caller_address: test.privacy.roles.app_governor,
    );
    let result = test.privacy.safe_set_fee_amount(fee_amount: constants::DEFAULT_FEE_AMOUNT);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_FEE_COLLECTOR);
}

#[test]
fn test_set_fee_collector_assertions() {
    let test: Test = Default::default();

    let result = test.privacy.safe_set_fee_collector(fee_collector: Zero::zero());
    assert_panic_with_error(:result, expected_error: AccessErrors::ONLY_APP_GOVERNOR.describe());

    let fee_collector: ContractAddress = 'FEE_COLLECTOR'.try_into().unwrap();
    test.privacy.set_fee_collector(:fee_collector);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector);
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());

    test.privacy.set_fee_amount(constants::DEFAULT_FEE_AMOUNT);
    assert_eq!(test.privacy.get_fee_amount(), constants::DEFAULT_FEE_AMOUNT);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector);
    cheat_caller_address_once(
        contract_address: test.privacy.address, caller_address: test.privacy.roles.app_governor,
    );
    let result = test.privacy.safe_set_fee_collector(fee_collector: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_FEE_COLLECTOR);

    test.privacy.set_fee_amount(Zero::zero());
    test.privacy.set_fee_collector(Zero::zero());
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());
    assert_eq!(test.privacy.get_fee_collector(), Zero::zero());
}

#[test]
fn test_set_depositor_blocked() {
    let test: Test = Default::default();
    let depositor: ContractAddress = 'DEPOSITOR'.try_into().unwrap();

    assert!(!test.privacy.is_depositor_blocked(:depositor));

    let mut spy = spy_events();
    test.privacy.set_depositor_blocked(:depositor, blocked: true);
    assert!(test.privacy.is_depositor_blocked(:depositor));
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        expected_event: events::DepositorBlockSet { depositor, blocked: true },
        expected_event_selector: @selector!("DepositorBlockSet"),
        expected_event_name: "DepositorBlockSet",
    );

    // Unblocking clears the flag and emits with `blocked: false`.
    let mut spy = spy_events();
    test.privacy.set_depositor_blocked(:depositor, blocked: false);
    assert!(!test.privacy.is_depositor_blocked(:depositor));
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        expected_event: events::DepositorBlockSet { depositor, blocked: false },
        expected_event_selector: @selector!("DepositorBlockSet"),
        expected_event_name: "DepositorBlockSet",
    );
}

#[test]
fn test_set_depositor_blocked_assertions() {
    let test: Test = Default::default();
    let depositor: ContractAddress = 'DEPOSITOR'.try_into().unwrap();

    // Catch ONLY_SECURITY_GOVERNOR: default caller lacks the role.
    let result = test.privacy.safe_set_depositor_blocked(:depositor, blocked: true);
    assert_panic_with_error(
        :result, expected_error: AccessErrors::ONLY_SECURITY_GOVERNOR.describe(),
    );

    // Catch ZERO_CONTRACT_ADDRESS: the zero address cannot be blocked.
    cheat_caller_address_once(
        contract_address: test.privacy.address,
        caller_address: test.privacy.roles.security_governor,
    );
    let result = test.privacy.safe_set_depositor_blocked(depositor: Zero::zero(), blocked: true);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_CONTRACT_ADDRESS);
}

/// Flow test for fee amount and fee collector updates.
#[test]
fn test_set_fee_amount_and_collector_flow() {
    let test: Test = Default::default();
    let actions: Array<ServerAction> = array![];
    let actions = actions.span();
    let strk_token = test.privacy.strk_token;
    let privacy_address = test.privacy.address;
    let caller: ContractAddress = 'FEE_PAYER'.try_into().unwrap();
    let fee_collector_1: ContractAddress = 'FEE_COLLECTOR_1'.try_into().unwrap();
    let fee_collector_2: ContractAddress = 'FEE_COLLECTOR_2'.try_into().unwrap();
    let fee_amount_1: u128 = constants::DEFAULT_FEE_AMOUNT;
    let fee_amount_2: u128 = constants::DEFAULT_FEE_AMOUNT + 1;

    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());
    assert_eq!(test.privacy.get_fee_collector(), Zero::zero());
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector_1), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector_2), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    // No fee configured yet, so apply_actions succeeds unfunded and moves no STRK.
    test.privacy.safe_apply_actions_as_unfunded(:actions, :caller).unwrap();
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector_1), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector_2), Zero::zero());

    // Set collector first, then enable fees.
    test.privacy.set_fee_collector(fee_collector: fee_collector_1);
    test.privacy.set_fee_amount(fee_amount: fee_amount_1);

    // Fees are now collected to collector 1.
    test.privacy.apply_actions_as(:actions, :caller);
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector_1), fee_amount_1.into());
    assert_eq!(strk_token.balance_of(address: fee_collector_2), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    // Changing only the collector redirects the next fee.
    test.privacy.set_fee_collector(fee_collector: fee_collector_2);
    test.privacy.apply_actions_as(:actions, :caller);
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector_1), fee_amount_1.into());
    assert_eq!(strk_token.balance_of(address: fee_collector_2), fee_amount_1.into());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    // Changing only the amount changes the collected fee.
    test.privacy.set_fee_amount(fee_amount: fee_amount_2);
    test.privacy.apply_actions_as(:actions, :caller);
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector_1), fee_amount_1.into());
    assert_eq!(
        strk_token.balance_of(address: fee_collector_2), (fee_amount_1 + fee_amount_2).into(),
    );
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    // Setting fee amount back to zero disables fee collection.
    test.privacy.set_fee_amount(0);
    test.privacy.safe_apply_actions_as_unfunded(:actions, :caller).unwrap();
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_collector_1), fee_amount_1.into());
    assert_eq!(
        strk_token.balance_of(address: fee_collector_2), (fee_amount_1 + fee_amount_2).into(),
    );
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());
}

#[test]
fn test_set_screener_public_key() {
    let mut test: Test = Default::default();
    assert_eq!(test.privacy.get_screener_public_key(), screener_key_pair().public_key);

    let new_screener_public_key = derive_public_key(private_key: 'NEW_SCREENER_SK');
    assert_ne!(new_screener_public_key, test.privacy.get_screener_public_key());
    let mut spy = spy_events();
    test.privacy.set_screener_public_key(screener_public_key: new_screener_public_key);
    assert_eq!(test.privacy.get_screener_public_key(), new_screener_public_key);
    let expected_event = events::ScreenerPublicKeySet {
        screener_public_key: new_screener_public_key,
    };
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 1);
    assert_expected_event_emitted(
        spied_event: events[0],
        :expected_event,
        expected_event_selector: @selector!("ScreenerPublicKeySet"),
        expected_event_name: "ScreenerPublicKeySet",
    );
}

#[test]
fn test_set_screener_public_key_assertions() {
    let mut test: Test = Default::default();

    // Catch ONLY_SECURITY_GOVERNOR.
    let result = test.privacy.safe_set_screener_public_key(screener_public_key: 7);
    assert_panic_with_error(
        :result, expected_error: AccessErrors::ONLY_SECURITY_GOVERNOR.describe(),
    );

    // Catch INVALID_PUBLIC_KEY.
    cheat_caller_address_once(
        contract_address: test.privacy.address,
        caller_address: test.privacy.roles.security_governor,
    );
    let result = test.privacy.safe_set_screener_public_key(screener_public_key: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_PUBLIC_KEY);

    // Catch INVALID_PUBLIC_KEY (non-zero but not a valid Stark curve point).
    cheat_caller_address_once(
        contract_address: test.privacy.address,
        caller_address: test.privacy.roles.security_governor,
    );
    let result = test.privacy.safe_set_screener_public_key(screener_public_key: 5);
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_PUBLIC_KEY);
}

#[test]
fn test_get_version() {
    let mut test: Test = Default::default();
    assert_eq!(test.privacy.get_version(), '2.0');
}
