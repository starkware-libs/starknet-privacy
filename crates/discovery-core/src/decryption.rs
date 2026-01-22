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
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EncryptionInputs {
        recipient_private_key: Felt,
        channel_key: Felt,
        sender: Felt,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EncryptionOutputs {
        ephemeral_pubkey: Felt,
        enc_channel_key: Felt,
        enc_sender_addr: Felt,
    }

    #[derive(Deserialize)]
    struct Encryption {
        inputs: EncryptionInputs,
        outputs: EncryptionOutputs,
    }

    #[derive(Deserialize)]
    struct Fixture {
        encryption: Encryption,
    }

    fn load_fixture() -> Fixture {
        const JSON: &str = include_str!("../tests/fixtures/cairo-reference-data.json");
        serde_json::from_str(JSON).expect("failed to parse fixture")
    }

    #[test]
    fn test_decrypt_channel_info_invalid_pubkey() {
        let enc = EncChannelInfo {
            ephemeral_pubkey: Felt::ZERO,
            enc_channel_key: Felt::ONE,
            enc_sender_addr: Felt::TWO,
        };
        let result = decrypt_channel_info(&enc, &Felt::from(12345u64));
        assert!(matches!(
            result,
            Err(DecryptionError::InvalidEphemeralPubkey)
        ));
    }

    #[test]
    fn test_decrypt_channel_info_with_cairo_vectors() {
        let f = load_fixture();
        let i = &f.encryption.inputs;
        let o = &f.encryption.outputs;

        let encrypted = EncChannelInfo {
            ephemeral_pubkey: o.ephemeral_pubkey,
            enc_channel_key: o.enc_channel_key,
            enc_sender_addr: o.enc_sender_addr,
        };

        let result = decrypt_channel_info(&encrypted, &i.recipient_private_key)
            .expect("decryption should succeed");

        assert_eq!(result.channel_key, i.channel_key);
        assert_eq!(result.sender_addr, i.sender);
    }
}
