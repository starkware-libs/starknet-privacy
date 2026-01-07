use core::ec::stark_curve::{GEN_X, GEN_Y, ORDER};
use core::ec::{EcPoint, EcPointTrait};
use privacy::hashes::{
    compute_enc_amount_hash, compute_enc_channel_key_hash, compute_enc_private_key_hash,
    compute_enc_sender_addr_hash, compute_enc_token_hash,
};
use privacy::objects::{EncChannelInfo, EncPrivateKey, EncSubchannelInfo};
use starknet::ContractAddress;
use starknet::storage::{StorageAsPointer, StoragePath};

pub mod constants {
    use core::num::traits::Pow;

    pub const TWO_POW_120: u128 = 2_u128.pow(120);
}

// TODO: Test the util and hash functions.

/// Returns the generator point.
pub fn GEN_P() -> EcPoint {
    EcPointTrait::new(x: GEN_X, y: GEN_Y).unwrap()
}

/// Encrypts the subchannel info.
/// Assumes all the inputs are not zero.
///
/// `enc_subchannel_info = (random, enc_token)`.
/// `enc_token = h(ENC_TOKEN_TAG, channel_key, random) + token`
pub(crate) fn encrypt_subchannel_info(
    channel_key: felt252, token: ContractAddress, random: felt252,
) -> EncSubchannelInfo {
    let enc_token = compute_enc_token_hash(:channel_key, :random) + token.into();
    EncSubchannelInfo { random, enc_token }
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
    let enc_sender_addr = compute_enc_sender_addr_hash(:shared_x) + sender_addr.into();
    EncChannelInfo { ephemeral_pubkey: ephemeral_pub_x, enc_channel_key, enc_sender_addr }
}

/// Encrypts the private key for the compliance using ECDH.
/// Assumes all the inputs are not zero.
///
/// High level:
/// - User picks a fresh random scalar `r` (= `ephemeral_secret`).
/// - User publishes the ephemeral public key `R = rG` (only the x-coordinate is stored).
/// - User derives a shared secret with the copmliance:
///   `S = r * K_copmliance`, where `K_copmliance` is the copmliance's public key as a curve point
///   (only the x-coordinate is used as the shared secret material).
///
/// Specifically, we output:
/// - `ephemeral_pubkey = (rG).x`
/// - `enc_private_key  = h( ENC_PRIVATE_KEY_TAG, (rK_copmliance).x ) + private_key`
///
/// Decryption (Compliance):
/// - Reconstruct `R` from `R.x` (curve point recovery).
/// - Compute `S = k_copmliance * R = k_copmliance * (rG)`.
/// - Take `S.x` and subtract the same hash masks to recover the plaintext fields.
pub(crate) fn encrypt_private_key(
    ephemeral_secret: felt252, compliance_public_key: felt252, private_key: felt252,
) -> EncPrivateKey {
    // Compute ephemeral public key.
    let ephemeral_pub_point = GEN_P().mul(scalar: ephemeral_secret);
    let ephemeral_pub_x = ephemeral_pub_point.try_into().unwrap().x();
    // Compute shared point.
    let compliance_public_point = EcPointTrait::new_from_x(x: compliance_public_key).unwrap();
    let shared_point = compliance_public_point.mul(scalar: ephemeral_secret);
    let shared_x = shared_point.try_into().unwrap().x();
    // Encrypt channel information.
    let enc_private_key = compute_enc_private_key_hash(:shared_x) + private_key;
    EncPrivateKey { ephemeral_pubkey: ephemeral_pub_x, enc_private_key }
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

// TODO: Refactor to (r, h(c,r) + amount).
/// Encrypts the note amount.
/// Assumes `random` is 120 bits.
pub(crate) fn encrypt_note_amount(channel_key: felt252, random: u128, amount: u128) -> felt252 {
    // TODO: Use the random.
    compute_enc_amount_hash(channel_key) + amount.into()
}

// TODO: Refactor with encrypt_note_amount.
/// Decrypts the note amount from `EncNote`.
/// This is the inverse of `encrypt_note_amount`.
pub(crate) fn decrypt_note_amount(enc_note_value: felt252, channel_key: felt252) -> u128 {
    (enc_note_value - compute_enc_amount_hash(:channel_key)).try_into().unwrap()
}

pub(crate) impl StoragePathIntoFelt<
    T, +StorageAsPointer<StoragePath<T>>,
> of Into<StoragePath<T>, felt252> {
    fn into(self: StoragePath<T>) -> felt252 {
        self.as_ptr().__storage_pointer_address__.into()
    }
}
