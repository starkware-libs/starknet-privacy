use client_side::errors::Errors;
use client_side::interface::{
    IClientSideDispatcher, IClientSideDispatcherTrait, IClientSideSafeDispatcher,
    IClientSideSafeDispatcherTrait, NoteTrait,
};
use client_side::tests::test_utils::{deploy_client_side, safe_transfer_as_user, valid_note};
use starkware_utils_testing::test_utils::{assert_panic_with_felt_error, cheat_caller_address_once};

#[test]
fn test_transfer() {
    let cfg = deploy_client_side();
    let client_side = IClientSideDispatcher { contract_address: cfg.client_side_contract };

    cheat_caller_address_once(contract_address: cfg.client_side_contract, caller_address: cfg.user);
    let result = client_side
        .transfer(
            input: array![valid_note(:cfg, amount: 1), valid_note(:cfg, amount: 1)].span(),
            output: array![valid_note(:cfg, amount: 2)].span(),
        );
    let expected_result = array![
        NoteTrait::new(owner: cfg.user, token: cfg.token, amount: 2).hash(),
    ]
        .span();
    assert_eq!(result, expected_result);
}

#[test]
#[feature("safe_dispatcher")]
fn test_transfer_assertions() {
    let cfg = deploy_client_side();
    let client_side_safe = IClientSideSafeDispatcher { contract_address: cfg.client_side_contract };
    let different_token = 'ANOTHER_TOKEN'.try_into().unwrap();

    // Catch NOTE_OWNER_MISMATCH
    let result = client_side_safe
        .transfer(
            input: array![valid_note(:cfg, amount: 1)].span(),
            output: array![valid_note(:cfg, amount: 1)].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::NOTE_OWNER_MISMATCH);

    // Catch NOTE_TOKEN_MISMATCH in input
    let result = safe_transfer_as_user(
        cfg,
        array![
            valid_note(:cfg, amount: 1),
            NoteTrait::new(owner: cfg.user, token: different_token, amount: 1),
        ]
            .span(),
        array![valid_note(:cfg, amount: 2)].span(),
    );
    assert_panic_with_felt_error(:result, expected_error: Errors::NOTE_TOKEN_MISMATCH);

    // Catch NOTE_TOKEN_MISMATCH in output
    let result = safe_transfer_as_user(
        cfg,
        array![valid_note(:cfg, amount: 2)].span(),
        array![
            valid_note(:cfg, amount: 1),
            NoteTrait::new(owner: cfg.user, token: different_token, amount: 1),
        ]
            .span(),
    );
    assert_panic_with_felt_error(:result, expected_error: Errors::NOTE_TOKEN_MISMATCH);

    // Catch NOTE_SUM_MISMATCH (input sum > output sum)
    let result = safe_transfer_as_user(
        cfg, array![valid_note(:cfg, amount: 2)].span(), array![valid_note(:cfg, amount: 1)].span(),
    );
    assert_panic_with_felt_error(:result, expected_error: Errors::NOTE_SUM_MISMATCH);

    // Catch NOTE_SUM_MISMATCH (input sum < output sum)
    let result = safe_transfer_as_user(
        cfg, array![valid_note(:cfg, amount: 1)].span(), array![valid_note(:cfg, amount: 2)].span(),
    );
    assert_panic_with_felt_error(:result, expected_error: Errors::NOTE_SUM_MISMATCH);
}
