use core::num::traits::Zero;
use privacy::tests::utils_for_tests::{PrivacyCfgTrait, Test, TestTrait, constants};
use privacy::{errors, events};
use snforge_std::{EventSpyTrait, EventsFilterTrait, spy_events};
use starknet::ContractAddress;
use starkware_utils::components::roles::errors::AccessErrors;
use starkware_utils::errors::Describable;
use starkware_utils_testing::test_utils::{
    assert_expected_event_emitted, assert_panic_with_error, assert_panic_with_felt_error,
    cheat_caller_address_once,
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

    // Catch ONLY_TOKEN_ADMIN.
    let result = test
        .privacy
        .safe_set_auditor_public_key(auditor_public_key: test.auditor.public_key);
    assert_panic_with_error(:result, expected_error: AccessErrors::ONLY_TOKEN_ADMIN.describe());

    // Catch ZERO_AUDITOR_PUBLIC_KEY.
    cheat_caller_address_once(
        contract_address: test.privacy.address, caller_address: test.privacy.roles.token_admin,
    );
    let result = test.privacy.safe_set_auditor_public_key(auditor_public_key: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_AUDITOR_PUBLIC_KEY);
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
