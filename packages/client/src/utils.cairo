use core::ec::stark_curve::{GEN_X, GEN_Y, ORDER};
use core::ec::{EcPoint, EcPointTrait};
use core::hash::{HashStateExTrait, HashStateTrait};
use core::poseidon::{PoseidonTrait, poseidon_hash_span};
use server::objects::EncChannelInfo;
use server::objects::domain_separation::{
    CHANNEL_ID_TAG, CHANNEL_KEY_TAG, NULLIFIER_TAG, enc_channel_info, enc_note,
};
use starknet::ContractAddress;

// TODO: Consider separate (common?) file for compute hashes functions.

// TODO: Move to a different file?
/// Returns the generator point.
pub fn GEN_P() -> EcPoint {
    EcPointTrait::new(x: GEN_X, y: GEN_Y).unwrap()
}

/// Hashes a span of felt252 values.
pub(crate) fn hash(data: Span<felt252>) -> felt252 {
    // TODO: Replace the hash function.
    PoseidonTrait::new().update_with(poseidon_hash_span(data)).finalize()
}

/// Computes the channel key.
/// Assumes all the inputs are not zero.
pub(crate) fn compute_channel_key(
    sender_addr: ContractAddress,
    sender_private_key: felt252,
    recipient_addr: ContractAddress,
    recipient_public_key: felt252,
    token: ContractAddress,
) -> felt252 {
    hash(
        [
            CHANNEL_KEY_TAG, sender_addr.into(), sender_private_key, recipient_addr.into(),
            recipient_public_key, token.into(),
        ]
            .span(),
    )
}

/// Computes the channel id given the channel key.
/// Assumes the channel key is not zero.
pub(crate) fn compute_channel_id(channel_key: felt252) -> felt252 {
    hash([CHANNEL_ID_TAG, channel_key].span())
}

/// Computes the hash used to encrypt the channel key in `EncChannelInfo`.
pub(crate) fn compute_enc_channel_key_hash(shared_x: felt252) -> felt252 {
    hash([enc_channel_info::ENC_CHANNEL_KEY_TAG, shared_x].span())
}

/// Computes the hash used to encrypt the token in `EncChannelInfo`.
pub(crate) fn compute_enc_token_hash(shared_x: felt252) -> felt252 {
    hash([enc_channel_info::ENC_TOKEN_TAG, shared_x].span())
}

/// Computes the hash used to encrypt the sender address in `EncChannelInfo`.
pub(crate) fn compute_enc_sender_addr_hash(shared_x: felt252) -> felt252 {
    hash([enc_channel_info::ENC_SENDER_ADDR_TAG, shared_x].span())
}

/// Encrypts channel info using ECDH.
/// Assumes all the inputs are not zero.
///
/// High level:
/// - Sender picks a fresh random scalar `r` (= `ephemeral_secret`).
/// - Sender publishes the ephemeral public key `R = rG` (only the x-coordinate is stored).
/// - Sender derives a shared secret with the recipient:
///   `S = r * K_recipient`, where `K_recipient` is the recipient’s public key as a curve point
///   (only the x-coordinate is used as the shared secret material).
///
/// Specifically, we output:
/// - `ephemeral_pubkey = (rG).x`
/// - `enc_channel_key  = h( ENC_CHANNEL_KEY_TAG, (rK_recipient).x ) + channel_key`
/// - `enc_token        = h( ENC_TOKEN_TAG, (rK_recipient).x ) + token`
/// - `enc_sender_addr  = h( ENC_SENDER_ADDR_TAG, (rK_recipient).x ) + sender_addr`
//
/// Decryption (Recipient):
/// - Reconstruct `R` from `R.x` (curve point recovery).
/// - Compute `S = k_recipient * R = k_recipient * (rG)`.
/// - Take `S.x` and subtract the same hash masks to recover the plaintext fields.
pub(crate) fn encrypt_channel_info(
    ephemeral_secret: felt252,
    recipient_public_key: felt252,
    channel_key: felt252,
    token: ContractAddress,
    sender_addr: ContractAddress,
) -> EncChannelInfo {
    // Compute ephemeral public key.
    let ephemeral_pub_point = GEN_P().mul(scalar: ephemeral_secret);
    let ephemeral_pub_x = ephemeral_pub_point.try_into().unwrap().x();
    // Compute shared point.
    let recipient_public_point = EcPointTrait::new_from_x(x: recipient_public_key).unwrap();
    let shared_point = recipient_public_point.mul(scalar: ephemeral_secret);
    let shared_x = shared_point.try_into().unwrap().x();
    // Encrypt channel information.
    let enc_channel_key = compute_enc_channel_key_hash(:shared_x) + channel_key;
    let enc_token = compute_enc_token_hash(:shared_x) + token.into();
    let enc_sender_addr = compute_enc_sender_addr_hash(:shared_x) + sender_addr.into();
    EncChannelInfo {
        ephemeral_pubkey: ephemeral_pub_x, enc_channel_key, enc_token, enc_sender_addr,
    }
}

/// Decrypts the channel key and token from `EncChannelInfo`.
pub(crate) fn decrypt_channel_info(
    enc_channel_info: EncChannelInfo, recipient_private_key: felt252,
) -> (felt252, ContractAddress) {
    let ephemeral_pubkey_point = EcPointTrait::new_from_x(x: enc_channel_info.ephemeral_pubkey)
        .unwrap();
    let shared_point = ephemeral_pubkey_point.mul(scalar: recipient_private_key);
    let shared_x = shared_point.try_into().unwrap().x();
    let channel_key = enc_channel_info.enc_channel_key - compute_enc_channel_key_hash(shared_x);
    let token = (enc_channel_info.enc_token - compute_enc_token_hash(shared_x))
        .try_into()
        // TODO: Consider adding internal errors file.
        .expect('TOKEN_DECRYPT_ERROR');

    (channel_key, token)
}

/// Derives the public key from the private key.
/// Assumes the private key is not zero.
pub(crate) fn derive_public_key(private_key: felt252) -> felt252 {
    let private_key_point = GEN_P().mul(scalar: private_key);
    private_key_point.try_into().unwrap().x()
}

/// Checks if the key is canonical, i.e. less than ORDER / 2.
pub(crate) fn is_canonical_key(key: felt252) -> bool {
    key.into() < (ORDER.into() / 2_u256)
}

/// Computes the note id.
// TODO: Remove public_key from note_id?
pub(crate) fn compute_note_id(channel_key: felt252, index: usize, public_key: felt252) -> felt252 {
    hash([enc_note::NOTE_ID_TAG, channel_key, index.into(), public_key].span())
}

/// Computes the hash used to encrypt the note amount in `EncNote`.
pub(crate) fn compute_enc_amount_hash(channel_key: felt252, index: usize) -> felt252 {
    hash([enc_note::ENC_AMOUNT_TAG, channel_key, index.into()].span())
}

/// Encrypts the note amount.
pub(crate) fn encrypt_note_amount(channel_key: felt252, index: usize, amount: u128) -> felt252 {
    compute_enc_amount_hash(channel_key, index) + amount.into()
}

/// Decrypts the note amount from `EncNote`.
pub(crate) fn decrypt_note_amount(
    enc_note_value: felt252, channel_key: felt252, index: usize,
) -> u128 {
    (enc_note_value - compute_enc_amount_hash(:channel_key, :index)).try_into().unwrap()
}

/// Computes the nullifier.
pub(crate) fn compute_nullifier(
    channel_key: felt252, index: usize, owner_private_key: felt252,
) -> felt252 {
    hash([NULLIFIER_TAG, channel_key, index.into(), owner_private_key].span())
}
