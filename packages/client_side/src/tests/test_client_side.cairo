use client_side::errors as Errors;
use client_side::objects::{NewNoteTrait, NotePathTrait};
use client_side::tests::test_utils::{Test, TestTrait, UserTrait};
use core::num::traits::Zero;
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use starkware_utils_testing::test_utils::{assert_panic_with_felt_error, generic_load};

#[test]
fn test_constructor() {
    let mut test: Test = Default::default();

    let actual_server = generic_load(
        target: test.cfg.address, storage_address: selector!("server"),
    );
    assert_eq!(actual_server, test.cfg.server);
}

#[test]
#[should_panic(expected_error: "SERVER_ZERO_ADDRESS")]
fn test_constructor_server_zero_address() {
    let mut calldata = array![];
    calldata.append(Zero::zero());
    declare(contract: "ClientSide")
        .unwrap()
        .contract_class()
        .deploy(constructor_calldata: @calldata)
        .unwrap();
}


#[test]
fn test_transfer() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.new_token();

    let result = user_1
        .transfer(
            notes_to_use: array![
                NotePathTrait::new(channel_index: 0, note_index: 0),
                NotePathTrait::new(channel_index: 0, note_index: 1),
            ]
                .span(),
            notes_to_create: array![NewNoteTrait::new(recipient: user_2.address, :token, amount: 2)]
                .span(),
        );

    let expected_result = ([].span(), [].span());
    assert_eq!(result, expected_result);
}

#[test]
fn test_transfer_one_to_many() {
    let mut test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let user_3 = test.new_user();
    let token = test.new_token();

    let result = user_1
        .transfer(
            notes_to_use: array![NotePathTrait::new(channel_index: 0, note_index: 0)].span(),
            notes_to_create: array![
                NewNoteTrait::new(recipient: user_2.address, :token, amount: 1),
                NewNoteTrait::new(recipient: user_2.address, :token, amount: 1),
                NewNoteTrait::new(recipient: user_3.address, :token, amount: 8),
            ]
                .span(),
        );
    let expected_result = ([].span(), [].span());
    assert_eq!(result, expected_result);
}

#[test]
fn test_transfer_many_to_one() {
    let mut test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.new_token();

    let result = user_1
        .transfer(
            notes_to_use: array![
                NotePathTrait::new(channel_index: 0, note_index: 0),
                NotePathTrait::new(channel_index: 0, note_index: 1),
            ]
                .span(),
            notes_to_create: array![NewNoteTrait::new(recipient: user_2.address, :token, amount: 2)]
                .span(),
        );
    let expected_result = ([].span(), [].span());
    assert_eq!(result, expected_result);

    let result = user_1
        .transfer(
            notes_to_use: array![
                NotePathTrait::new(channel_index: 0, note_index: 0),
                NotePathTrait::new(channel_index: 0, note_index: 1),
            ]
                .span(),
            notes_to_create: array![NewNoteTrait::new(recipient: user_1.address, :token, amount: 2)]
                .span(),
        );
    let expected_result = ([].span(), [].span());
    assert_eq!(result, expected_result);
}

#[test]
#[feature("safe_dispatcher")]
fn test_transfer_assertions() {
    let mut test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.new_token();

    // Catch NO_NOTES_TO_USE
    let result = user_1
        .safe_transfer(
            notes_to_use: array![].span(),
            notes_to_create: array![NewNoteTrait::new(recipient: user_2.address, :token, amount: 1)]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::NO_NOTES_TO_USE);

    // Catch NO_NOTES_TO_CREATE
    let result = user_1
        .safe_transfer(
            notes_to_use: array![NotePathTrait::new(channel_index: 0, note_index: 0)].span(),
            notes_to_create: array![].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::NO_NOTES_TO_CREATE);

    // Catch NOTE_AMOUNT_MUST_BE_NON_ZERO
    let result = user_1
        .safe_transfer(
            notes_to_use: array![NotePathTrait::new(channel_index: 0, note_index: 0)].span(),
            notes_to_create: array![NewNoteTrait::new(recipient: user_2.address, :token, amount: 0)]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::NOTE_AMOUNT_MUST_BE_NON_ZERO);
}
