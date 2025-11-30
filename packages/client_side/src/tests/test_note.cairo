use client_side::interface::NoteTrait;
use client_side::tests::test_utils::TestTrait;
use core::hash::{HashStateExTrait, HashStateTrait};
use core::num::traits::Zero;
use core::poseidon::PoseidonTrait;

#[test]
fn test_note_new() {
    let mut test = Default::default();
    let user = test.new_user();
    let token = test.new_token();
    let amount = 100;

    let note = NoteTrait::new(owner: user.address, :token, :amount);
    assert_eq!(note.owner(), user.address);
    assert_eq!(note.token(), token);
    assert_eq!(note.amount(), amount);
    assert_eq!(note.hash(), PoseidonTrait::new().update_with(note).finalize());
}

#[test]
#[should_panic(expected_error: Errors::NOTE_ZERO_AMOUNT)]
fn test_note_zero_amount() {
    let mut test = Default::default();
    NoteTrait::new(owner: test.new_user().address, token: test.new_token(), amount: 0);
}

#[test]
#[should_panic(expected_error: Errors::NOTE_OWNER_ZERO_ADDRESS)]
fn test_note_zero_owner() {
    let mut test = Default::default();
    NoteTrait::new(owner: Zero::zero(), token: test.new_token(), amount: 1);
}

#[test]
#[should_panic(expected_error: Errors::NOTE_TOKEN_ZERO_ADDRESS)]
fn test_note_zero_token() {
    let mut test = Default::default();
    NoteTrait::new(owner: test.new_user().address, token: Zero::zero(), amount: 1);
}
