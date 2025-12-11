use core::ec::stark_curve::{GEN_X, GEN_Y, ORDER};
use core::ec::{EcPoint, EcPointTrait};
use core::hash::{HashStateExTrait, HashStateTrait};
use core::poseidon::{PoseidonTrait, poseidon_hash_span};
use server::objects::EncChannelInfo;
use server::objects::domain_separation::{CHANNEL_ID_TAG, CHANNEL_KEY_TAG, enc_channel_info};
use starknet::ContractAddress;

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
    let enc_channel_key = hash([enc_channel_info::ENC_CHANNEL_KEY_TAG, shared_x].span())
        + channel_key;
    let enc_token = hash([enc_channel_info::ENC_TOKEN_TAG, shared_x].span()) + token.into();
    let enc_sender_addr = hash([enc_channel_info::ENC_SENDER_ADDR_TAG, shared_x].span())
        + sender_addr.into();
    EncChannelInfo {
        ephemeral_pubkey: ephemeral_pub_x, enc_channel_key, enc_token, enc_sender_addr,
    }
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
