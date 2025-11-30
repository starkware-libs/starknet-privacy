use client_side::errors::Errors;
use client_side::interface::NoteTrait;
use client_side::tests::test_utils::{Test, TestTrait, UserTrait};
use starkware_utils_testing::test_utils::assert_panic_with_felt_error;

#[test]
fn test_transfer() {
    let mut test: Test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let token = test.new_token();

    let result = user_1
        .transfer(
            input: array![
                NoteTrait::new(owner: user_1.address, :token, amount: 1),
                NoteTrait::new(owner: user_1.address, :token, amount: 1),
            ]
                .span(),
            output: array![NoteTrait::new(owner: user_2.address, :token, amount: 2)].span(),
        );
    let expected_result = array![NoteTrait::new(owner: user_2.address, :token, amount: 2).hash()]
        .span();
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
            input: array![NoteTrait::new(owner: user_1.address, :token, amount: 10)].span(),
            output: array![
                NoteTrait::new(owner: user_2.address, :token, amount: 1),
                NoteTrait::new(owner: user_2.address, :token, amount: 1),
                NoteTrait::new(owner: user_3.address, :token, amount: 8),
            ]
                .span(),
        );
    let expected_result = array![
        NoteTrait::new(owner: user_2.address, :token, amount: 1).hash(),
        NoteTrait::new(owner: user_2.address, :token, amount: 1).hash(),
        NoteTrait::new(owner: user_3.address, :token, amount: 8).hash(),
    ]
        .span();
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
            input: array![
                NoteTrait::new(owner: user_1.address, :token, amount: 1),
                NoteTrait::new(owner: user_1.address, :token, amount: 1),
            ]
                .span(),
            output: array![NoteTrait::new(owner: user_2.address, :token, amount: 2)].span(),
        );
    let expected_result = array![NoteTrait::new(owner: user_2.address, :token, amount: 2).hash()]
        .span();
    assert_eq!(result, expected_result);

    let result = user_1
        .transfer(
            input: array![
                NoteTrait::new(owner: user_1.address, :token, amount: 1),
                NoteTrait::new(owner: user_1.address, :token, amount: 1),
            ]
                .span(),
            output: array![NoteTrait::new(owner: user_1.address, :token, amount: 2)].span(),
        );
    let expected_result = array![NoteTrait::new(owner: user_1.address, :token, amount: 2).hash()]
        .span();
    assert_eq!(result, expected_result);
}

#[test]
#[feature("safe_dispatcher")]
fn test_transfer_assertions() {
    let mut test = Default::default();
    let user_1 = test.new_user();
    let user_2 = test.new_user();
    let token_1 = test.new_token();
    let token_2 = test.new_token();

    // Catch EMPTY_TRANSFER_INPUT
    let result = user_1
        .safe_transfer(
            array![].span(),
            array![NoteTrait::new(owner: user_2.address, token: token_2, amount: 1)].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::EMPTY_TRANSFER_INPUT);

    // Catch EMPTY_TRANSFER_OUTPUT
    let result = user_1
        .safe_transfer(
            array![NoteTrait::new(owner: user_1.address, token: token_1, amount: 1)].span(),
            array![].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::EMPTY_TRANSFER_OUTPUT);

    // Catch NOTE_OWNER_MISMATCH
    let result = user_2
        .safe_transfer(
            array![NoteTrait::new(owner: user_1.address, token: token_1, amount: 1)].span(),
            array![NoteTrait::new(owner: user_2.address, token: token_2, amount: 1)].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::NOTE_OWNER_MISMATCH);

    // Catch NOTE_TOKEN_MISMATCH in input
    let result = user_1
        .safe_transfer(
            array![
                NoteTrait::new(owner: user_1.address, token: token_1, amount: 1),
                NoteTrait::new(owner: user_1.address, token: token_2, amount: 1),
            ]
                .span(),
            array![NoteTrait::new(owner: user_2.address, token: token_1, amount: 2)].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::NOTE_TOKEN_MISMATCH);

    // Catch NOTE_TOKEN_MISMATCH in output
    let result = user_1
        .safe_transfer(
            array![NoteTrait::new(owner: user_1.address, token: token_1, amount: 2)].span(),
            array![
                NoteTrait::new(owner: user_1.address, token: token_1, amount: 1),
                NoteTrait::new(owner: user_1.address, token: token_2, amount: 1),
            ]
                .span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::NOTE_TOKEN_MISMATCH);

    // Catch NOTE_SUM_MISMATCH (input sum > output sum)
    let result = user_1
        .safe_transfer(
            array![NoteTrait::new(owner: user_1.address, token: token_1, amount: 2)].span(),
            array![NoteTrait::new(owner: user_2.address, token: token_1, amount: 1)].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::NOTE_SUM_MISMATCH);

    // Catch NOTE_SUM_MISMATCH (input sum < output sum)
    let result = user_1
        .safe_transfer(
            array![NoteTrait::new(owner: user_1.address, token: token_1, amount: 1)].span(),
            array![NoteTrait::new(owner: user_2.address, token: token_1, amount: 2)].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: Errors::NOTE_SUM_MISMATCH);
}
