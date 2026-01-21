use core::iter::Extend;
use core::never;

pub const ZERO_RECIPIENT_ADDR: felt252 = 'ZERO_RECIPIENT_ADDR';
pub const ZERO_TOKEN: felt252 = 'ZERO_TOKEN';
pub const ZERO_RANDOM: felt252 = 'ZERO_RANDOM';
pub const SALT_EXCEEDS_120_BITS: felt252 = 'SALT_EXCEEDS_120_BITS';
pub const PRIVATE_KEY_NOT_CANONICAL: felt252 = 'PRIVATE_KEY_NOT_CANONICAL';
pub const SENDER_NOT_REGISTERED: felt252 = 'SENDER_NOT_REGISTERED';
pub const SENDER_NOT_AUTHENTICATED: felt252 = 'SENDER_NOT_AUTHENTICATED';
pub const ZERO_AMOUNT: felt252 = 'ZERO_AMOUNT';
pub const SUBCHANNEL_NOT_FOUND: felt252 = 'SUBCHANNEL_NOT_FOUND';
pub const INDEX_NOT_SEQUENTIAL: felt252 = 'INDEX_NOT_SEQUENTIAL';
pub const NOTE_NOT_FOUND: felt252 = 'NOTE_NOT_FOUND';
pub const ZERO_WITHDRAWAL_TARGET: felt252 = 'ZERO_WITHDRAWAL_TARGET';
pub const ZERO_PRIVATE_KEY: felt252 = 'ZERO_PRIVATE_KEY';
pub const ZERO_USER_ADDR: felt252 = 'ZERO_USER_ADDR';
pub const ZERO_CHANNEL_KEY: felt252 = 'ZERO_CHANNEL_KEY';
pub const INVALID_CHANNEL: felt252 = 'INVALID_CHANNEL';
pub const NON_ZERO_VALUE: felt252 = 'NON_ZERO_VALUE';
pub const VALUE_MISMATCH: felt252 = 'VALUE_MISMATCH';
pub const ZERO_RECIPIENT_PUBLIC_KEY: felt252 = 'ZERO_RECIPIENT_PUBLIC_KEY';
pub const ACTIONS_OUT_OF_ORDER: felt252 = 'ACTIONS_OUT_OF_ORDER';
pub const INVALID_SIGNATURE: felt252 = 'INVALID_SIGNATURE';
/// Panic data:
/// - [0] NEGATIVE_INTERMEDIATE_BALANCE
/// - [1] Token address
pub const NEGATIVE_INTERMEDIATE_BALANCE: felt252 = 'NEGATIVE_INTERMEDIATE_BALANCE';
/// Panic data:
/// - [0] FINAL_BALANCE_MUST_BE_ZERO
/// - [1] Token address
pub const FINAL_BALANCE_MUST_BE_ZERO: felt252 = 'FINAL_BALANCE_MUST_BE_ZERO';
pub const INVALID_CALLER: felt252 = 'INVALID_CALLER';
pub const NO_PRIVACY_ACTIONS: felt252 = 'NO_PRIVACY_ACTIONS';

pub(crate) mod internal_errors {
    pub const ZERO_ENC_CHANNEL_INFO: felt252 = 'ZERO_ENC_CHANNEL_INFO';
    pub const ZERO_CHANNEL_ID: felt252 = 'ZERO_CHANNEL_ID';
    pub const ZERO_NOTE_ID: felt252 = 'ZERO_NOTE_ID';
    pub const ZERO_ENC_NOTE_VALUE: felt252 = 'ZERO_ENC_NOTE_VALUE';
    pub const ZERO_NULLIFIER: felt252 = 'ZERO_NULLIFIER';
    pub const ACTIONS_LENGTH_MISMATCH: felt252 = 'ACTIONS_LENGTH_MISMATCH';
    pub const ZERO_SUBCHANNEL_ID: felt252 = 'ZERO_SUBCHANNEL_ID';
    pub const ZERO_SUBCHANNEL_KEY: felt252 = 'ZERO_SUBCHANNEL_KEY';
    pub const ZERO_ENC_SUBCHANNEL_TOKEN: felt252 = 'ZERO_ENC_SUBCHANNEL_TOKEN';
    pub const ZERO_DERIVED_PUBLIC_KEY: felt252 = 'ZERO_DERIVED_PUBLIC_KEY';
    pub const ZERO_ENC_PRIVATE_KEY: felt252 = 'ZERO_ENC_PRIVATE_KEY';
    pub const UNEXPECTED_ZERO_AMOUNT: felt252 = 'UNEXPECTED_ZERO_AMOUNT';
    pub const DESERIALIZE_FAILED: felt252 = 'DESERIALIZE_FAILED';
    pub const EXPECTED_PANIC: felt252 = 'EXPECTED_PANIC';
}

pub(crate) fn panic_with_context(error: felt252, ctx: Span<felt252>) -> never {
    let mut data = array![error];
    let ctx_array: Array<felt252> = ctx.into();
    data.extend(ctx_array);
    panic(data);
}

pub(crate) fn assert_with_context(cond: bool, error: felt252, ctx: Span<felt252>) {
    if !cond {
        panic_with_context(:error, :ctx);
    }
}
