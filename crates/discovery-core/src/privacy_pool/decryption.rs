//! Decryption functions for privacy pool encrypted data.
//!
//! This module provides ECDH-based decryption functions for various
//! encrypted structures stored in the privacy pool contract.

use starknet_types_core::{curve::AffinePoint, felt::Felt};
use thiserror::Error;

use super::hashes::{
    compute_enc_amount_hash, compute_enc_channel_key_hash, compute_enc_recipient_addr_hash,
    compute_enc_sender_addr_hash, compute_enc_token_hash,
};
use super::types::{
    felt_low_u128, ChannelInfo, EncChannelInfo, EncOutgoingChannelInfo, EncSubchannelInfo,
    SecretFelt,
};

/// Salt value indicating an open (plaintext) note.
/// Open notes store their amount unencrypted in the lower 128 bits.
pub const OPEN_NOTE_SALT: u128 = 1;

/// Errors that can occur during decryption.
#[derive(Debug, Error)]
pub enum DecryptionError {
    /// The ephemeral public key x-coordinate is not on the curve.
    #[error("invalid ephemeral pubkey: x-coordinate is not on the curve")]
    InvalidEphemeralPubkey,
}

/// Decrypts encrypted channel info using ECDH.
///
/// The decryption process:
/// 1. Recover the ephemeral public key point from its x-coordinate
/// 2. Compute ECDH shared secret: `shared_point = ephemeral_pubkey * private_key`
/// 3. Decrypt: `plaintext = ciphertext - hash(tag, shared_x)`
pub fn decrypt_channel_info(
    enc: &EncChannelInfo,
    private_key: &SecretFelt,
) -> Result<ChannelInfo, DecryptionError> {
    // Recover the ephemeral public key from x-coordinate..
    let ephemeral_point = AffinePoint::new_from_x(&enc.ephemeral_pubkey, false)
        .ok_or(DecryptionError::InvalidEphemeralPubkey)?;
    let shared_point = &ephemeral_point * **private_key;
    let shared_x = shared_point.x();

    // Decrypt: plaintext = ciphertext - hash(tag, shared_x)
    let channel_key = enc.enc_channel_key - compute_enc_channel_key_hash(shared_x);
    let sender_addr = enc.enc_sender_addr - compute_enc_sender_addr_hash(shared_x);

    Ok(ChannelInfo {
        channel_key: SecretFelt::new(channel_key),
        sender_addr,
    })
}

/// Decrypts encrypted subchannel info to get the token address.
///
/// The decryption process:
/// `token = enc_token - hash(ENC_TOKEN_TAG, channel_key, index, 0, salt)`
///
/// # Arguments
///
/// * `enc` - The encrypted subchannel info (salt and enc_token).
/// * `channel_key` - The channel key for this subchannel.
/// * `index` - The subchannel index.
///
/// # Returns
///
/// The decrypted token address.
pub fn decrypt_subchannel_token(
    enc: &EncSubchannelInfo,
    channel_key: &SecretFelt,
    index: u64,
) -> Felt {
    let enc_token_hash = compute_enc_token_hash(channel_key, index, enc.salt);
    enc.enc_token - enc_token_hash
}

/// Unpacks a packed note amount into salt and encrypted amount.
///
/// Packed format (big-endian): `packed = salt * 2^128 + enc_amount`
/// - Bytes [0..16]: salt
/// - Bytes [16..32]: enc_amount
pub fn unpack_note_amount(packed_amount: Felt) -> (u128, u128) {
    let d = packed_amount.to_le_digits();
    let enc_amount = d[0] as u128 | (d[1] as u128) << 64;
    let salt = d[2] as u128 | (d[3] as u128) << 64;
    (salt, enc_amount)
}

/// Decrypts an encrypted note amount.
///
/// `amount = (enc_amount - pad) % 2^128`
/// where `pad = hash(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt) % 2^128`
pub fn decrypt_note_amount(
    enc_amount: u128,
    salt: u128,
    channel_key: &SecretFelt,
    token: Felt,
    index: u64,
) -> u128 {
    let enc_amount_hash = compute_enc_amount_hash(channel_key, token, index, salt);
    let pad = felt_low_u128(enc_amount_hash);

    // Wrapping subtraction: (enc_amount - pad) % 2^128
    enc_amount.wrapping_sub(pad)
}

/// Unpacks and decrypts a packed note value into `(amount, salt)`.
///
/// Open notes (salt == 1) store their amount in plaintext; encrypted notes
/// (salt >= 2) require ECDH-based decryption.
pub fn decrypt_packed_value(
    packed: Felt,
    channel_key: &SecretFelt,
    token: Felt,
    index: u64,
) -> (u128, u128) {
    let (salt, enc_amount) = unpack_note_amount(packed);
    let amount = if salt == OPEN_NOTE_SALT {
        enc_amount
    } else {
        decrypt_note_amount(enc_amount, salt, channel_key, token, index)
    };
    (amount, salt)
}

/// Decrypts an outgoing channel's encrypted recipient address.
///
/// `recipient_addr = enc_recipient_addr - hash(ENC_RECIPIENT_ADDR_TAG, sender_addr, private_key, index, 0, salt)`
pub fn decrypt_outgoing_recipient_addr(
    enc: &EncOutgoingChannelInfo,
    sender_addr: Felt,
    private_key: &SecretFelt,
    index: u64,
) -> Felt {
    let mask = compute_enc_recipient_addr_hash(sender_addr, private_key, index, enc.salt);
    enc.enc_recipient_addr - mask
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::load_cairo_ref_fixture;

    #[test]
    fn test_decrypt_channel_info_invalid_pubkey() {
        let enc = EncChannelInfo {
            ephemeral_pubkey: Felt::ZERO,
            enc_channel_key: Felt::ONE,
            enc_sender_addr: Felt::TWO,
        };
        let result = decrypt_channel_info(&enc, &SecretFelt::new(Felt::from(12345u64)));
        assert!(matches!(
            result,
            Err(DecryptionError::InvalidEphemeralPubkey)
        ));
    }

    #[test]
    fn test_decrypt_channel_info_with_cairo_vectors() {
        let f = load_cairo_ref_fixture();

        let encrypted = EncChannelInfo {
            ephemeral_pubkey: f.outputs.enc_channel_ephemeral_pubkey,
            enc_channel_key: f.outputs.enc_channel_key,
            enc_sender_addr: f.outputs.enc_channel_sender_addr,
        };

        let result = decrypt_channel_info(&encrypted, &f.inputs.recipient_private_key)
            .expect("decryption should succeed");

        assert_eq!(*result.channel_key, *f.inputs.channel_key);
        assert_eq!(result.sender_addr, f.inputs.sender);
    }

    #[test]
    fn test_decrypt_subchannel_token_with_cairo_vectors() {
        let f = load_cairo_ref_fixture();

        let encrypted = EncSubchannelInfo {
            salt: f.outputs.enc_subchannel_salt,
            enc_token: f.outputs.enc_subchannel_token,
        };

        let token = decrypt_subchannel_token(&encrypted, &f.inputs.channel_key, f.inputs.index);
        assert_eq!(token, f.inputs.token);
    }

    #[test]
    fn test_unpack_and_decrypt_note_amount_with_cairo_vectors() {
        let f = load_cairo_ref_fixture();

        let (salt, enc_amount) = unpack_note_amount(f.outputs.enc_note_amount);
        let expected_salt = felt_low_u128(f.inputs.salt);
        assert_eq!(salt, expected_salt);

        let amount = decrypt_note_amount(
            enc_amount,
            salt,
            &f.inputs.channel_key,
            f.inputs.token,
            f.inputs.index,
        );
        assert_eq!(amount, f.outputs.dec_note_amount as u128);
    }

    #[test]
    fn test_unpack_open_note_returns_plaintext_amount() {
        let amount: u128 = 50_000_000_000_000_000_000; // 50 STRK in wei
        let salt = OPEN_NOTE_SALT;
        // Pack: salt in upper 128 bits, amount in lower 128 bits
        let packed = Felt::from(salt) * Felt::from(1u128 << 64) * Felt::from(1u128 << 64)
            + Felt::from(amount);
        let (unpacked_salt, unpacked_amount) = unpack_note_amount(packed);
        assert_eq!(unpacked_salt, salt, "salt should be OPEN_NOTE_SALT");
        assert_eq!(
            unpacked_amount, amount,
            "open note amount should be plaintext"
        );
    }

    #[test]
    fn test_decrypt_outgoing_recipient_addr_with_cairo_vectors() {
        let f = load_cairo_ref_fixture();

        let enc = EncOutgoingChannelInfo {
            salt: f.outputs.enc_outgoing_salt,
            enc_recipient_addr: f.outputs.enc_outgoing_recipient_addr,
        };

        let recipient = decrypt_outgoing_recipient_addr(
            &enc,
            f.inputs.sender,
            &f.inputs.sender_private_key,
            f.inputs.index,
        );
        assert_eq!(recipient, f.inputs.recipient);
    }
}
