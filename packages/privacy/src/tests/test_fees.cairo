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
fn test_set_fee() {
    let test: Test = Default::default();
    let fee_amount_1: u128 = constants::DEFAULT_FEE_AMOUNT;
    let fee_collector_1: ContractAddress = 'FEE_COLLECTOR_1'.try_into().unwrap();
    let fee_amount_2: u128 = constants::DEFAULT_FEE_AMOUNT + 1;
    let fee_collector_2: ContractAddress = 'FEE_COLLECTOR_2'.try_into().unwrap();

    // Verify the default fee is set.
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());
    assert_eq!(test.privacy.get_fee_collector(), Zero::zero());

    // Change both fee amount and collector (set collector first, then amount).
    test.privacy.set_fee_collector(fee_collector: fee_collector_1);
    test.privacy.set_fee_amount(fee_amount: fee_amount_1);
    assert_eq!(test.privacy.get_fee_amount(), fee_amount_1);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector_1);

    // Change only the fee amount (keep same collector).
    test.privacy.set_fee_amount(fee_amount: fee_amount_2);
    assert_eq!(test.privacy.get_fee_amount(), fee_amount_2);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector_1);

    // Change only the collector (keep same fee amount).
    test.privacy.set_fee_collector(fee_collector: fee_collector_2);
    assert_eq!(test.privacy.get_fee_amount(), fee_amount_2);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector_2);

    // Change neither (set same values again).
    test.privacy.set_fee_collector(fee_collector: fee_collector_2);
    test.privacy.set_fee_amount(fee_amount: fee_amount_2);
    assert_eq!(test.privacy.get_fee_amount(), fee_amount_2);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector_2);

    // Set zero amount with non-zero collector (allowed, collector is stored but unused).
    test.privacy.set_fee_amount(0);
    assert_eq!(test.privacy.get_fee_amount(), 0);
    assert_eq!(test.privacy.get_fee_collector(), fee_collector_2);

    // Set zero amount with zero collector (disabling fees).
    test.privacy.set_fee_collector(Zero::zero());
    assert_eq!(test.privacy.get_fee_amount(), 0);
    assert_eq!(test.privacy.get_fee_collector(), Zero::zero());
}

#[test]
fn test_set_fee_event() {
    let test: Test = Default::default();
    let fee_amount: u128 = constants::DEFAULT_FEE_AMOUNT;
    let fee_collector: ContractAddress = 'FEE_COLLECTOR_1'.try_into().unwrap();

    let mut spy = spy_events();
    test.privacy.set_fee_collector(:fee_collector);
    test.privacy.set_fee_amount(:fee_amount);
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 2);
    assert_expected_event_emitted(
        spied_event: events[0],
        expected_event: events::FeeSet { fee_amount: Zero::zero(), fee_collector },
        expected_event_selector: @selector!("FeeSet"),
        expected_event_name: "FeeSet",
    );
    assert_expected_event_emitted(
        spied_event: events[1],
        expected_event: events::FeeSet { fee_amount, fee_collector },
        expected_event_selector: @selector!("FeeSet"),
        expected_event_name: "FeeSet",
    );

    // Set the same values again.
    let mut spy = spy_events();
    test.privacy.set_fee_collector(:fee_collector);
    test.privacy.set_fee_amount(:fee_amount);
    let events = spy.get_events().emitted_by(contract_address: test.privacy.address).events;
    assert_eq!(events.len(), 2);
    assert_expected_event_emitted(
        spied_event: events[0],
        expected_event: events::FeeSet { fee_amount, fee_collector },
        expected_event_selector: @selector!("FeeSet"),
        expected_event_name: "FeeSet",
    );
    assert_expected_event_emitted(
        spied_event: events[1],
        expected_event: events::FeeSet { fee_amount, fee_collector },
        expected_event_selector: @selector!("FeeSet"),
        expected_event_name: "FeeSet",
    );
}

#[test]
fn test_set_fee_assertions() {
    let test: Test = Default::default();

    // Catch access control: calling set_fee_amount without app_governor role.
    let result = test.privacy.safe_set_fee_amount(fee_amount: Zero::zero());
    assert_panic_with_error(:result, expected_error: ONLY_APP_GOVERNOR.describe());

    // Catch access control: calling set_fee_collector without app_governor role.
    let result = test.privacy.safe_set_fee_collector(fee_collector: Zero::zero());
    assert_panic_with_error(:result, expected_error: ONLY_APP_GOVERNOR.describe());

    // Catch ZERO_FEE_COLLECTOR: non-zero fee_amount with zero fee_collector, as app_governor.
    cheat_caller_address_once(
        contract_address: test.privacy.address, caller_address: test.privacy.roles.app_governor,
    );
    let result = test.privacy.safe_set_fee_amount(fee_amount: constants::DEFAULT_FEE_AMOUNT);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_FEE_COLLECTOR);

    // Catch ZERO_FEE_COLLECTOR: set fee_collector to zero while fee_amount is non-zero.
    test.privacy.set_fee_collector('FEE_COLLECTOR'.try_into().unwrap());
    test.privacy.set_fee_amount(constants::DEFAULT_FEE_AMOUNT);
    cheat_caller_address_once(
        contract_address: test.privacy.address, caller_address: test.privacy.roles.app_governor,
    );
    let result = test.privacy.safe_set_fee_collector(fee_collector: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_FEE_COLLECTOR);

    // Verify zero fee_amount with zero collector is allowed (disabling fees).
    test.privacy.set_fee_amount(Zero::zero());
    test.privacy.set_fee_collector(Zero::zero());
    assert_eq!(test.privacy.get_fee_amount(), Zero::zero());
    assert_eq!(test.privacy.get_fee_collector(), Zero::zero());
}
