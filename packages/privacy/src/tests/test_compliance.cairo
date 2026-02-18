use core::num::traits::Zero;
use privacy::tests::utils_for_tests::{PrivacyCfgTrait, Test, TestTrait};
use privacy::{errors, events};
use snforge_std::{EventSpyTrait, EventsFilterTrait, spy_events};
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
