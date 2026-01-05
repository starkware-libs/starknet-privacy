use core::ec::stark_curve::{GEN_X, GEN_Y, ORDER};
use core::ec::{EcPoint, EcPointTrait};
use core::num::traits::Pow;
use privacy::hashes::{
    compute_enc_amount_hash, compute_enc_channel_key_hash, compute_enc_private_key_hash,
    compute_enc_sender_addr_hash, compute_enc_token_hash,
};
use privacy::objects::{EncChannelInfo, EncPrivateKey, EncSubchannelInfo};
use starknet::ContractAddress;
use starknet::storage::{StorageAsPointer, StoragePath};
use starkware_utils::constants::TWO_POW_128;

// TODO: Define internal errors for errors in this file.

// TODO: Different file?
// TODO: Define mod constants?
// TODO: pub instead of pub(crate)?
pub(crate) const TWO_POW_120: u256 = 2_u256.pow(120);

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

/// Encrypts the note amount. The result is packed into a single felt252 value.
/// The first 120 bits are the random value, and the last 128 bits are the encrypted amount.
/// The encrypted amount is computed modulo 2^128.
/// Assumes all the inputs are not zero, and `random` is 120 bits.
///
/// `enc_amount = packing(random, (h(ENC_AMOUNT_TAG, channel_key, random) + amount) % 2^128)`.
pub(crate) fn encrypt_note_amount(channel_key: felt252, random: felt252, amount: u128) -> felt252 {
    let enc_amount = (compute_enc_amount_hash(:channel_key, :random) + amount.into())
        .into() % TWO_POW_128;
    packing(value_1: random, value_2: enc_amount.try_into().expect('ENC_AMOUNT_OVERFLOW'))
}

/// Decrypts the note amount from `EncNote`.
/// This is the inverse of `encrypt_note_amount`.
pub(crate) fn decrypt_note_amount(enc_note_value: felt252, channel_key: felt252) -> u128 {
    let (random, enc_amount) = unpacking(packed_value: enc_note_value);
    let enc_amount_u256: u256 = enc_amount.into(); // already < 2^128 by construction
    let pad: u256 = compute_enc_amount_hash(channel_key, random).into() % TWO_POW_128;
    let amount: u256 = (enc_amount_u256 + TWO_POW_128 - pad) % TWO_POW_128;
    amount.try_into().expect('AMOUNT_OVERFLOW')
}

pub(crate) impl StoragePathIntoFelt<
    T, +StorageAsPointer<StoragePath<T>>,
> of Into<StoragePath<T>, felt252> {
    fn into(self: StoragePath<T>) -> felt252 {
        self.as_ptr().__storage_pointer_address__.into()
    }
}

// TODO: Move to utils repo?
/// Packing two felt252 values into a single felt252 value.
/// Equivalent to (value_1 << 128) | value_2.
/// Assumes: value_1 is 120 bits, value_2 is 128 bits.
pub(crate) fn packing(value_1: felt252, value_2: felt252) -> felt252 {
    (value_1.into() * TWO_POW_128 + value_2.into()).try_into().expect('PACK_OVERFLOW')
}


// TODO: Move to utils repo?
/// Unpacking a single felt252 into two felt252 values (120 bits for value_1, 128 bits for value_2).
/// Inverse of `packing`: `packed_value = value_1 * 2^128 + value_2`
pub(crate) fn unpacking(packed_value: felt252) -> (felt252, felt252) {
    let packed_u256: u256 = packed_value.into();
    let value_1 = packed_u256 / TWO_POW_128;
    let value_2 = packed_u256 % TWO_POW_128;
    // TODO: Assert bounds?
    // TODO: Assert value_1 is 120 bits?
    (value_1.try_into().expect('UNPACK1_OVERFLOW'), value_2.try_into().expect('UNPACK2_OVERFLOW'))
}
