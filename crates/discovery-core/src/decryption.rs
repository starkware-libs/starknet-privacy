//! Decryption functions for privacy pool encrypted data.
//!
//! This module provides ECDH-based decryption functions for various
//! encrypted structures stored in the privacy pool contract.

use starknet_types_core::{curve::AffinePoint, felt::Felt};
use thiserror::Error;

use crate::hashes::{compute_enc_channel_key_hash, compute_enc_sender_addr_hash};
use crate::types::{ChannelInfo, EncChannelInfo};

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
///
/// # Security
///
/// The caller should zero the `private_key` after use by calling `private_key.zeroize()`.
pub fn decrypt_channel_info(
    enc: &EncChannelInfo,
    private_key: &Felt,
) -> Result<ChannelInfo, DecryptionError> {
    // Recover the ephemeral public key from x-coordinate..
    let ephemeral_point = AffinePoint::new_from_x(&enc.ephemeral_pubkey, false)
        .ok_or(DecryptionError::InvalidEphemeralPubkey)?;
    let shared_point = &ephemeral_point * *private_key;
    let shared_x = shared_point.x();

    // Decrypt: plaintext = ciphertext - hash(tag, shared_x)
    let channel_key = enc.enc_channel_key - compute_enc_channel_key_hash(shared_x);
    let sender_addr = enc.enc_sender_addr - compute_enc_sender_addr_hash(shared_x);

    Ok(ChannelInfo {
        channel_key,
        sender_addr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decrypt_channel_info_invalid_pubkey() {
        // Test with an invalid x-coordinate that's not on the curve
        let enc = EncChannelInfo {
            ephemeral_pubkey: Felt::ZERO, // 0 is not a valid x-coordinate on the Stark curve
            enc_channel_key: Felt::ONE,
            enc_sender_addr: Felt::TWO,
        };
        let private_key = Felt::from(12345u64);

        let result = decrypt_channel_info(&enc, &private_key);
        assert!(matches!(
            result,
            Err(DecryptionError::InvalidEphemeralPubkey)
        ));
    }

    #[test]
    fn test_decrypt_channel_info_with_cairo_vectors() {
        // Test vectors from Cairo's generate_reference_hashes
        let enc = EncChannelInfo {
            ephemeral_pubkey: Felt::from_dec_str(
                "3317515146291950322439739918503052161382072816692247665260809440131850150059",
            )
            .unwrap(),
            enc_channel_key: Felt::from_dec_str(
                "2100624802620692495330515891693085948471346774203502915677436177625912381801",
            )
            .unwrap(),
            enc_sender_addr: Felt::from_dec_str(
                "3426713546607510520125236734093074738323219400404327089385598578631730499182",
            )
            .unwrap(),
        };
        let private_key = Felt::from_dec_str("97102652448424643357525340").unwrap();

        let result = decrypt_channel_info(&enc, &private_key).expect("decryption should succeed");

        let expected_channel_key = Felt::from_dec_str(
            "677755493975975963352247547288552470765954598923190207943815023432319447829",
        )
        .unwrap();
        let expected_sender_addr = Felt::from_dec_str(
            "3378351110828728548300509446963845863121770589275180623352847054544020051774",
        )
        .unwrap();

        assert_eq!(result.channel_key, expected_channel_key);
        assert_eq!(result.sender_addr, expected_sender_addr);
    }
}
