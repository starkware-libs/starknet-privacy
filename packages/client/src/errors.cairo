// TODO: Consider merging errors between different functions.
// Common errors.
// Open channel, create note.
pub const ZERO_RECIPIENT_ADDR: felt252 = 'ZERO_RECIPIENT_ADDR';
// Open channel, create note.
pub const ZERO_TOKEN: felt252 = 'ZERO_TOKEN';

// Constructor errors.
pub const ZERO_SERVER: felt252 = 'ZERO_SERVER';

// Open channel errors.
pub const ZERO_SENDER_ADDR: felt252 = 'ZERO_SENDER_ADDR';
pub const ZERO_SENDER_PRIVATE_KEY: felt252 = 'ZERO_SENDER_PRIVATE_KEY';
pub const ZERO_RANDOM: felt252 = 'ZERO_RANDOM';
pub const PRIVATE_KEY_NOT_CANONICAL: felt252 = 'PRIVATE_KEY_NOT_CANONICAL';
pub const SENDER_NOT_REGISTERED: felt252 = 'SENDER_NOT_REGISTERED';
pub const SENDER_NOT_AUTHENTICATED: felt252 = 'SENDER_NOT_AUTHENTICATED';
pub const RECIPIENT_NOT_REGISTERED: felt252 = 'RECIPIENT_NOT_REGISTERED';

// Transfer errors.
pub const ZERO_OWNER_ADDR: felt252 = 'ZERO_OWNER_ADDR';
pub const ZERO_OWNER_PRIVATE_KEY: felt252 = 'ZERO_OWNER_PRIVATE_KEY';
pub const NO_NOTES_TO_USE: felt252 = 'NO_NOTES_TO_USE';
pub const NO_NOTES_TO_CREATE: felt252 = 'NO_NOTES_TO_CREATE';
pub const NOTE_SUM_MISMATCH: felt252 = 'NOTE_SUM_MISMATCH';

// Create note errors.
pub const ZERO_AMOUNT: felt252 = 'ZERO_AMOUNT';
pub const CHANNEL_NOT_FOUND: felt252 = 'CHANNEL_NOT_FOUND';
pub const NOTE_INDEX_NOT_SEQUENTIAL: felt252 = 'NOTE_INDEX_NOT_SEQUENTIAL';

// Deposit errors.
pub const NON_SELF_DEPOSIT: felt252 = 'NON_SELF_DEPOSIT';
