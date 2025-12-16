// TODO: Consider defining common errors in a separate package for both client and server.
// Open channel errors.
pub const ZERO_RECIPIENT_ADDR: felt252 = 'ZERO_RECIPIENT_ADDR';
pub const ZERO_ENC_CHANNEL_INFO: felt252 = 'ZERO_ENC_CHANNEL_INFO';
pub const ZERO_CHANNEL_ID: felt252 = 'ZERO_CHANNEL_ID';
pub const CHANNEL_ALREADY_EXISTS: felt252 = 'CHANNEL_ALREADY_EXISTS';

// Create note errors.
pub const ZERO_NOTE_ID: felt252 = 'ZERO_NOTE_ID';
pub const ZERO_ENC_NOTE_VALUE: felt252 = 'ZERO_ENC_NOTE_VALUE';
pub const NOTE_ALREADY_EXISTS: felt252 = 'NOTE_ALREADY_EXISTS';

// Use note errors.
pub const ZERO_NULLIFIER: felt252 = 'ZERO_NULLIFIER';
pub const NULLIFIER_ALREADY_EXISTS: felt252 = 'NULLIFIER_ALREADY_EXISTS';

// Reigster errors.
pub const ZERO_PUBLIC_KEY: felt252 = 'ZERO_PUBLIC_KEY';
pub const USER_ALREADY_REGISTERED: felt252 = 'USER_ALREADY_REGISTERED';
pub const ZERO_ENC_PRIVATE_KEY: felt252 = 'ZERO_ENC_PRIVATE_KEY';

