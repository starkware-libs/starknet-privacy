use core::num::traits::Zero;
use privacy::errors;
use privacy::tests::utils_for_tests::{PrivacyCfgTrait, Test, constants};
use starknet::ContractAddress;
use starkware_utils::erc20::erc20_errors::Erc20Error;
use starkware_utils::errors::Describable;
use starkware_utils_testing::test_utils::{
    TokenHelperTrait, assert_panic_with_error, assert_panic_with_felt_error,
};

#[test]
fn test_set_fee() {
    let test: Test = Default::default();

    // Verify the default fee is set.
    assert_eq!(test.privacy.get_fee_amount(), constants::DEFAULT_FEE_AMOUNT);
    assert_eq!(test.privacy.get_fee_recipient(), constants::DEFAULT_FEE_RECIPIENT);

    // Change fee.
    let new_fee_recipient: ContractAddress = 'NEW_FEE_RECIPIENT'.try_into().unwrap();
    let new_fee_amount: u128 = 2000;
    test.privacy.set_fee(fee_amount: new_fee_amount, fee_recipient: new_fee_recipient);

    // Verify values were stored.
    assert_eq!(test.privacy.get_fee_amount(), new_fee_amount);
    assert_eq!(test.privacy.get_fee_recipient(), new_fee_recipient);

    // Set fee to zero to disable.
    test.privacy.set_fee(fee_amount: 0, fee_recipient: Zero::zero());

    // Verify values are zero.
    assert_eq!(test.privacy.get_fee_amount(), 0);
    assert_eq!(test.privacy.get_fee_recipient(), Zero::zero());
}

#[test]
fn test_set_fee_assertions() {
    let test: Test = Default::default();
    let fee_recipient: ContractAddress = 'FEE_RECIPIENT'.try_into().unwrap();

    // Catch ZERO_FEE_RECIPIENT: non-zero fee_amount with zero fee_recipient.
    let result = test.privacy.safe_set_fee(fee_amount: 1000, fee_recipient: Zero::zero());
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_FEE_RECIPIENT);

    // Catch access control: calling set_fee without app_governor role.
    // safe_set_fee does not cheat the caller, so the default caller has no role.
    let result = test.privacy.safe_set_fee(fee_amount: 1000, :fee_recipient);
    assert_panic_with_felt_error(:result, expected_error: 'ONLY_APP_GOVERNOR');

    // Verify zero fee_amount with zero recipient is allowed (disabling fees).
    test.privacy.set_fee(fee_amount: 0, fee_recipient: Zero::zero());
    assert_eq!(test.privacy.get_fee_amount(), 0);
}

#[test]
fn test_apply_actions_with_fee() {
    let test: Test = Default::default();
    let strk_token = test.privacy.strk_token;
    let fee_amount = test.privacy.get_fee_amount();
    let fee_recipient = test.privacy.get_fee_recipient();
    let privacy_address = test.privacy.address;
    let caller: ContractAddress = 'CALLER'.try_into().unwrap();

    // Verify all balances before apply_actions.
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_recipient), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    // Call apply_actions — the helper auto-funds the caller.
    test.privacy.apply_actions_as(actions: [].span(), :caller);

    // Verify balances after apply_actions: fee moved from caller to fee_recipient.
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_recipient), fee_amount.into());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());
}

#[test]
fn test_apply_actions_with_zero_fee() {
    let test: Test = Default::default();
    let strk_token = test.privacy.strk_token;
    let privacy_address = test.privacy.address;
    let caller: ContractAddress = 'NO_STRK_CALLER'.try_into().unwrap();
    let fee_recipient = test.privacy.get_fee_recipient();

    // Disable the fee.
    test.privacy.set_fee(fee_amount: 0, fee_recipient: Zero::zero());

    // Verify all balances before apply_actions.
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_recipient), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    // apply_actions should succeed without STRK funding.
    test.privacy.apply_actions_as(actions: [].span(), :caller);

    // Verify no balances changed.
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_recipient), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());
}

#[test]
fn test_apply_actions_with_fee_insufficient_balance() {
    let test: Test = Default::default();
    let strk_token = test.privacy.strk_token;
    let fee_recipient = test.privacy.get_fee_recipient();
    let privacy_address = test.privacy.address;
    let caller: ContractAddress = 'BROKE_CALLER'.try_into().unwrap();

    // Verify all balances before apply_actions.
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_recipient), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    // Caller has no STRK balance — use unfunded variant to skip auto-funding.
    let result = test.privacy.safe_apply_actions_as_unfunded(actions: [].span(), :caller);
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_BALANCE.describe());

    // Verify no balances changed.
    assert_eq!(strk_token.balance_of(address: caller), Zero::zero());
    assert_eq!(strk_token.balance_of(address: fee_recipient), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());
}

#[test]
fn test_apply_actions_with_fee_insufficient_allowance() {
    let test: Test = Default::default();
    let strk_token = test.privacy.strk_token;
    let fee_amount = test.privacy.get_fee_amount();
    let fee_recipient = test.privacy.get_fee_recipient();
    let privacy_address = test.privacy.address;
    let caller: ContractAddress = 'UNAPPROVED_CALLER'.try_into().unwrap();

    // Give caller STRK balance but do NOT approve.
    strk_token.supply(address: caller, amount: fee_amount);

    // Verify all balances before apply_actions.
    assert_eq!(strk_token.balance_of(address: caller), fee_amount.into());
    assert_eq!(strk_token.balance_of(address: fee_recipient), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());

    let result = test.privacy.safe_apply_actions_as_unfunded(actions: [].span(), :caller);
    assert_panic_with_error(:result, expected_error: Erc20Error::INSUFFICIENT_ALLOWANCE.describe());

    // Verify no balances changed.
    assert_eq!(strk_token.balance_of(address: caller), fee_amount.into());
    assert_eq!(strk_token.balance_of(address: fee_recipient), Zero::zero());
    assert_eq!(strk_token.balance_of(address: privacy_address), Zero::zero());
}
