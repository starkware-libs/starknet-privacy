use core::hash::{HashStateExTrait, HashStateTrait};
use core::num::traits::Zero;
use core::poseidon::{PoseidonTrait, poseidon_hash_span};
use domain_separation::*;
use starknet::ContractAddress;

/// Domain-separation tags for contract hashes.
///
/// Template (stable, lowercase):
/// <object_name>:<field_name>:v<major_version>'.
// TODO: Find good template for a single felt.
// TODO: Find better naming convention for tags.
pub mod domain_separation {
    /// Tag for `channel_id`.
    pub const CHANNEL_ID_TAG: felt252 = 'channel_id:v1';
    /// Tag for `channel_key`.
    pub const CHANNEL_KEY_TAG: felt252 = 'channel_key:v1';
    /// Tag for `subchannel_id`.
    pub const SUBCHANNEL_ID_TAG: felt252 = 'subchannel_id:v1';
    /// Tag for `subchannel_key`.
    pub const SUBCHANNEL_KEY_TAG: felt252 = 'subchannel_key:v1';
    /// Tag for `nullifier`.
    pub const NULLIFIER_TAG: felt252 = 'nullifier:v1';
    /// Tags for the `EncChannelInfo` struct.
    // TODO: Now using "channel_info" instead of "enc_channel_info" to fit in a single felt.
    pub mod enc_channel_info {
        pub const ENC_CHANNEL_KEY_TAG: felt252 = 'channel_info:enc_channel_key:v1';
        pub const ENC_SENDER_ADDR_TAG: felt252 = 'channel_info:enc_sender_addr:v1';
    }
    /// Tag for `note_id`.
    pub const NOTE_ID_TAG: felt252 = 'enc_note:id:v1';
    /// Tag for encrypted amount of the note.
    pub const ENC_AMOUNT_TAG: felt252 = 'enc_note:enc_amount:v1';
    /// Tags for the `EncSubchannelInfo` struct.
    // TODO: Now using "subchannel_info" instead of "enc_subchannel_info" to fit in a single felt.
    pub mod enc_subchannel_info {
        pub const ENC_TOKEN_TAG: felt252 = 'subchannel_info:enc_token:v1';
    }
    /// Tags for the `EncPrivateKey` struct.
    // TODO: Now using "private_key" instead of "enc_private_key" to fit in a single felt.
    pub mod enc_private_key {
        pub const ENC_PRIVATE_KEY_TAG: felt252 = 'private_key:enc_private_key:v1';
    }
    /// Tags for the `EncAddress` struct.
    pub mod enc_address {
        pub const ENC_ADDRESS_TAG: felt252 = 'enc_address:enc_address:v1';
    }
}


/// Hashes a span of felt252 values.
pub(crate) fn hash(data: Span<felt252>) -> felt252 {
    // TODO: Replace the hash function.
    PoseidonTrait::new().update_with(poseidon_hash_span(data)).finalize()
}

/// Computes the hash used to encrypt the private key in `EncPrivateKey`.
///
/// Returns `h(ENC_PRIVATE_KEY_TAG, shared_x)`
pub(crate) fn compute_enc_private_key_hash(shared_x: felt252) -> felt252 {
    hash([enc_private_key::ENC_PRIVATE_KEY_TAG, shared_x].span())
}

/// Computes the hash used to encrypt the address in `EncAddress`.
///
/// Returns `h(ENC_ADDRESS_TAG, shared_x)`
pub(crate) fn compute_enc_address_hash(shared_x: felt252) -> felt252 {
    hash([enc_address::ENC_ADDRESS_TAG, shared_x].span())
}

/// Computes the hash used to encrypt the token in `EncSubchannelInfo`.
///
/// Returns `h(ENC_TOKEN_TAG, channel_key, index, 0, salt)`
pub(crate) fn compute_enc_token_hash(channel_key: felt252, index: usize, salt: felt252) -> felt252 {
    hash([enc_subchannel_info::ENC_TOKEN_TAG, channel_key, index.into(), Zero::zero(), salt].span())
}


/// Computes the hash used to encrypt the channel key in `EncChannelInfo`.
///
/// Returns `h(ENC_CHANNEL_KEY_TAG, shared_x)`
pub(crate) fn compute_enc_channel_key_hash(shared_x: felt252) -> felt252 {
    hash([enc_channel_info::ENC_CHANNEL_KEY_TAG, shared_x].span())
}

/// Computes the hash used to encrypt the sender address in `EncChannelInfo`.
///
/// Returns `h(ENC_SENDER_ADDR_TAG, shared_x)`
pub(crate) fn compute_enc_sender_addr_hash(shared_x: felt252) -> felt252 {
    hash([enc_channel_info::ENC_SENDER_ADDR_TAG, shared_x].span())
}


/// Computes the channel key.
/// Assumes all the inputs are not zero.
///
/// `channel_key = h(CHANNEL_KEY_TAG, sender_addr, sender_private_key, recipient_addr,
/// recipient_public_key)`
pub(crate) fn compute_channel_key(
    sender_addr: ContractAddress,
    sender_private_key: felt252,
    recipient_addr: ContractAddress,
    recipient_public_key: felt252,
) -> felt252 {
    hash(
        [
            CHANNEL_KEY_TAG, sender_addr.into(), sender_private_key, recipient_addr.into(),
            recipient_public_key,
        ]
            .span(),
    )
}

/// Computes the channel id given the channel key.
/// Assumes all the inputs are not zero.
///
/// `channel_id = h(CHANNEL_ID_TAG, channel_key, sender_addr, recipient_addr, recipient_public_key)`
pub(crate) fn compute_channel_id(
    channel_key: felt252,
    sender_addr: ContractAddress,
    recipient_addr: ContractAddress,
    recipient_public_key: felt252,
) -> felt252 {
    hash(
        [
            CHANNEL_ID_TAG, channel_key, sender_addr.into(), recipient_addr.into(),
            recipient_public_key,
        ]
            .span(),
    )
}

/// Computes the subchannel key given the channel key and index.
/// Assumes all the inputs are not zero.
/// Includes a reserved zero placeholder for forward compatibility, occupying the position of a
/// future hash component without affecting current behavior.
///
/// `subchannel_key = h(SUBCHANNEL_KEY_TAG, channel_key, index, 0)`
pub(crate) fn compute_subchannel_key(channel_key: felt252, index: usize) -> felt252 {
    hash([SUBCHANNEL_KEY_TAG, channel_key, index.into(), Zero::zero()].span())
}

/// Computes the subchannel id given the channel key and token.
/// Assumes all the inputs are not zero.
///
/// `subchannel_id = h(SUBCHANNEL_ID_TAG, channel_key, recipient_addr, recipient_public_key, token)`
pub(crate) fn compute_subchannel_id(
    channel_key: felt252,
    recipient_addr: ContractAddress,
    recipient_public_key: felt252,
    token: ContractAddress,
) -> felt252 {
    hash(
        [SUBCHANNEL_ID_TAG, channel_key, recipient_addr.into(), recipient_public_key, token.into()]
            .span(),
    )
}

/// Computes the note id.
/// Assumes `channel_key` and `token` are not zero.
/// Includes a reserved zero placeholder for forward compatibility, occupying the position of a
/// future hash component without affecting current behavior.
///
/// `note_id = h(NOTE_ID_TAG, channel_key, token, index, 0)`
pub(crate) fn compute_note_id(
    channel_key: felt252, token: ContractAddress, index: usize,
) -> felt252 {
    hash([NOTE_ID_TAG, channel_key, token.into(), index.into(), Zero::zero()].span())
}

/// Computes the hash used to encrypt the note amount.
/// Assumes `channel_key` and `token` are not zero.
///
/// Returns `h(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt)`.
pub(crate) fn compute_enc_amount_hash(
    channel_key: felt252, token: ContractAddress, index: usize, salt: u128,
) -> felt252 {
    hash(
        [ENC_AMOUNT_TAG, channel_key, token.into(), index.into(), Zero::zero(), salt.into()].span(),
    )
}

/// Computes the nullifier.
/// Assumes `channel_key`, `token`, and `owner_private_key` are not zero.
/// Includes a reserved zero placeholder to match the note_id hash layout.
///
/// `nullifier = h(NULLIFIER_TAG, channel_key, token, index, 0, owner_private_key)`
pub(crate) fn compute_nullifier(
    channel_key: felt252, token: ContractAddress, index: usize, owner_private_key: felt252,
) -> felt252 {
    hash(
        [NULLIFIER_TAG, channel_key, token.into(), index.into(), Zero::zero(), owner_private_key]
            .span(),
    )
}
