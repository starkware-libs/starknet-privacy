use core::num::traits::Zero;
use privacy::tests::utils_for_tests::{PrivacyCfgTrait, Test, constants};
use privacy::{errors, events};
use snforge_std::{EventSpyTrait, EventsFilterTrait, spy_events};
use starknet::ContractAddress;
use starkware_utils::components::roles::errors::AccessErrors::ONLY_APP_GOVERNOR;
use starkware_utils::errors::Describable;
use starkware_utils_testing::test_utils::{
    assert_expected_event_emitted, assert_panic_with_error, assert_panic_with_felt_error,
    cheat_caller_address_once,
};

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
    assert_panic_with_error(:result, expected_error: ONLY_APP_GOVERNOR.describe());

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
    assert_panic_with_error(:result, expected_error: ONLY_APP_GOVERNOR.describe());

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
