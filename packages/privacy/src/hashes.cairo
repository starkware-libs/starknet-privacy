use core::num::traits::Zero;
use core::poseidon::poseidon_hash_span;
use domain_separation::*;
use starknet::ContractAddress;

/// Domain-separation tags for contract hashes.
///
/// Template (uppercase): `<VAR_NAME>:V<VERSION>`.
pub mod domain_separation {
    /// Tag for `channel_marker`.
    pub const CHANNEL_MARKER_TAG: felt252 = 'CHANNEL_MARKER_TAG:V1';
    /// Tag for `channel_key`.
    pub const CHANNEL_KEY_TAG: felt252 = 'CHANNEL_KEY_TAG:V1';
    /// Tag for `subchannel_marker`.
    pub const SUBCHANNEL_MARKER_TAG: felt252 = 'SUBCHANNEL_MARKER_TAG:V1';
    /// Tag for `subchannel_id`.
    pub const SUBCHANNEL_ID_TAG: felt252 = 'SUBCHANNEL_ID_TAG:V1';
    /// Tag for `nullifier`.
    pub const NULLIFIER_TAG: felt252 = 'NULLIFIER_TAG:V1';
    /// Tag for the `EncChannelInfo.enc_channel_key`.
    pub const ENC_CHANNEL_KEY_TAG: felt252 = 'ENC_CHANNEL_KEY_TAG:V1';
    /// Tag for the `EncChannelInfo.enc_sender_addr`.
    pub const ENC_SENDER_ADDR_TAG: felt252 = 'ENC_SENDER_ADDR_TAG:V1';
    /// Tag for `note_id`.
    pub const NOTE_ID_TAG: felt252 = 'NOTE_ID_TAG:V1';
    /// Tag for encrypted amount of the note.
    pub const ENC_AMOUNT_TAG: felt252 = 'ENC_AMOUNT_TAG:V1';
    /// Tag for the `EncSubchannelInfo.enc_token`.
    pub const ENC_TOKEN_TAG: felt252 = 'ENC_TOKEN_TAG:V1';
    /// Tag for the `EncPrivateKey.enc_private_key`.
    pub const ENC_PRIVATE_KEY_TAG: felt252 = 'ENC_PRIVATE_KEY_TAG:V1';
    /// Tag for the `EncUserAddr.enc_user_addr`.
    pub const ENC_USER_ADDR_TAG: felt252 = 'ENC_USER_ADDR_TAG:V1';
    /// Tag for the `EncOutgoingChannelInfo.enc_recipient_addr`.
    pub const ENC_RECIPIENT_ADDR_TAG: felt252 = 'ENC_RECIPIENT_ADDR_TAG:V1';
    /// Tag for `outgoing_channel_id`.
    pub const OUTGOING_CHANNEL_ID_TAG: felt252 = 'OUTGOING_CHANNEL_ID_TAG:V1';
}


/// Hashes a span of felt252 values.
pub(crate) fn hash(data: Span<felt252>) -> felt252 {
    poseidon_hash_span(data)
}

/// Computes the hash used to encrypt the private key in `EncPrivateKey`.
///
/// Returns `h(ENC_PRIVATE_KEY_TAG, shared_x)`
pub(crate) fn compute_enc_private_key_hash(shared_x: felt252) -> felt252 {
    hash([ENC_PRIVATE_KEY_TAG, shared_x].span())
}

/// Computes the hash used to encrypt the address in `EncUserAddr`.
///
/// Returns `h(ENC_USER_ADDR_TAG, shared_x)`
pub(crate) fn compute_enc_user_addr_hash(shared_x: felt252) -> felt252 {
    hash([ENC_USER_ADDR_TAG, shared_x].span())
}

/// Computes the hash used to encrypt the token in `EncSubchannelInfo`.
///
/// Returns `h(ENC_TOKEN_TAG, channel_key, index, 0, salt)`
pub(crate) fn compute_enc_token_hash(channel_key: felt252, index: usize, salt: felt252) -> felt252 {
    hash([ENC_TOKEN_TAG, channel_key, index.into(), Zero::zero(), salt].span())
}


/// Computes the hash used to encrypt the channel key in `EncChannelInfo`.
///
/// Returns `h(ENC_CHANNEL_KEY_TAG, shared_x)`
pub(crate) fn compute_enc_channel_key_hash(shared_x: felt252) -> felt252 {
    hash([ENC_CHANNEL_KEY_TAG, shared_x].span())
}

/// Computes the hash used to encrypt the sender address in `EncChannelInfo`.
///
/// Returns `h(ENC_SENDER_ADDR_TAG, shared_x)`
pub(crate) fn compute_enc_sender_addr_hash(shared_x: felt252) -> felt252 {
    hash([ENC_SENDER_ADDR_TAG, shared_x].span())
}

/// Computes the hash used to encrypt the recipient address in `EncOutgoingChannelInfo`.
///
/// Returns `h(ENC_RECIPIENT_ADDR_TAG, sender_addr, sender_private_key, index, 0, salt)`
pub(crate) fn compute_enc_recipient_addr_hash(
    sender_addr: ContractAddress, sender_private_key: felt252, index: usize, salt: felt252,
) -> felt252 {
    hash(
        [
            ENC_RECIPIENT_ADDR_TAG, sender_addr.into(), sender_private_key, index.into(),
            Zero::zero(), salt,
        ]
            .span(),
    )
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

/// Computes the outgoing channel id.
/// Assumes `sender_addr` and `sender_private_key` are not zero.
///
/// `outgoing_channel_id = h(OUTGOING_CHANNEL_ID_TAG, sender_addr, sender_private_key, index, 0)`
pub(crate) fn compute_outgoing_channel_id(
    sender_addr: ContractAddress, sender_private_key: felt252, index: usize,
) -> felt252 {
    hash(
        [
            OUTGOING_CHANNEL_ID_TAG, sender_addr.into(), sender_private_key, index.into(),
            Zero::zero(),
        ]
            .span(),
    )
}

/// Computes the channel marker given the channel key.
/// Assumes all the inputs are not zero.
///
/// `channel_marker = h(CHANNEL_MARKER_TAG, channel_key, sender_addr, recipient_addr,
/// recipient_public_key)`
pub(crate) fn compute_channel_marker(
    channel_key: felt252,
    sender_addr: ContractAddress,
    recipient_addr: ContractAddress,
    recipient_public_key: felt252,
) -> felt252 {
    hash(
        [
            CHANNEL_MARKER_TAG, channel_key, sender_addr.into(), recipient_addr.into(),
            recipient_public_key,
        ]
            .span(),
    )
}

/// Computes the subchannel id given the channel key and index.
/// Assumes all the inputs are not zero.
/// Includes a reserved zero placeholder for forward compatibility, occupying the position of a
/// future hash component without affecting current behavior.
///
/// `subchannel_id = h(SUBCHANNEL_ID_TAG, channel_key, index, 0)`
pub(crate) fn compute_subchannel_id(channel_key: felt252, index: usize) -> felt252 {
    hash([SUBCHANNEL_ID_TAG, channel_key, index.into(), Zero::zero()].span())
}

/// Computes the subchannel marker given the channel key and token.
/// Assumes all the inputs are not zero.
///
/// `subchannel_marker = h(SUBCHANNEL_MARKER_TAG, channel_key, recipient_addr, recipient_public_key,
/// token)`
pub(crate) fn compute_subchannel_marker(
    channel_key: felt252,
    recipient_addr: ContractAddress,
    recipient_public_key: felt252,
    token: ContractAddress,
) -> felt252 {
    hash(
        [
            SUBCHANNEL_MARKER_TAG, channel_key, recipient_addr.into(), recipient_public_key,
            token.into(),
        ]
            .span(),
    )
}

/// Computes the note id.
/// Assumes `token` is not zero.
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
/// Assumes `token` is not zero.
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
/// Assumes `token` and `owner_private_key` are not zero.
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
