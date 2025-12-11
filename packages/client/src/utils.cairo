use core::ec::stark_curve::{GEN_X, GEN_Y};
use core::ec::{EcPoint, EcPointTrait};
use server::objects::EncChannelInfo;
use server::objects::domain_separation::enc_channel_info::{
    CHANNEL_KEY_TAG, SENDER_ADDR_TAG, TOKEN_TAG,
};
use starknet::ContractAddress;

// TODO: Move to a different file?
/// Returns the generator point.
pub fn GEN_P() -> EcPoint {
    EcPointTrait::new(x: GEN_X, y: GEN_Y).unwrap()
}

/// Hashes a span of felt252 values.
pub(crate) fn hash(data: Span<felt252>) -> felt252 {
    // TODO: Replace with real hash function.
    let mut hash = 0;
    for i in data {
        hash = hash + *i;
    }
    hash
}

/// Encrypts channel info using ECDH.
pub(crate) fn encrypt_channel_info(
    ephemeral_scalar: felt252,
    recipient_pubkey: felt252,
    channel_key: felt252,
    token: ContractAddress,
    sender_addr: ContractAddress,
) -> EncChannelInfo {
    // Compute ephemeral public key.
    let ephemeral_pub_point = GEN_P().mul(scalar: ephemeral_scalar);
    let ephemeral_pub_x = ephemeral_pub_point.try_into().unwrap().x();
    // Compute shared point.
    let recipient_pub_point = EcPointTrait::new_from_x(x: recipient_pubkey).unwrap();
    let shared_point = recipient_pub_point.mul(scalar: ephemeral_scalar);
    let shared_x = shared_point.try_into().unwrap().x();
    // Encrypt channel information.
    let enc_channel_key = hash([CHANNEL_KEY_TAG, shared_x].span()) + channel_key;
    let enc_token = hash([TOKEN_TAG, shared_x].span()) + token.into();
    let enc_sender_addr = hash([SENDER_ADDR_TAG, shared_x].span()) + sender_addr.into();
    EncChannelInfo {
        ephemeral_pubkey: ephemeral_pub_x, enc_channel_key, enc_token, enc_sender_addr,
    }
}
