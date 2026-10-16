//! Auditor-side key recovery for the privacy pool.
//!
//! The auditor holds a private key whose public key is registered on-chain as
//! `auditor_public_key`. Each user's `SetViewingKey` action stores their private
//! key encrypted to that auditor key (`EncPrivateKey`), so the auditor can recover
//! every user's viewing key. This module is the inverse of the Cairo
//! `encrypt_private_key` / `derive_public_key`, validated against the Cairo
//! reference vectors.

use starknet_types_core::{curve::AffinePoint, felt::Felt};

use super::decryption::DecryptionError;
use super::hashes::compute_enc_private_key_hash;
use super::types::{EncPrivateKey, SecretFelt};

/// Derives the public key (Stark-curve x-coordinate of `private_key * G`) from a
/// private key. Mirrors Cairo `derive_public_key`.
pub fn derive_public_key(private_key: &SecretFelt) -> Felt {
    starknet_crypto::get_public_key(private_key)
}

/// Recovers a user's private key from their auditor-encrypted `EncPrivateKey`,
/// using the auditor's private key.
///
/// Inverse of Cairo `encrypt_private_key`:
/// 1. recover the ephemeral point `R` from its stored x-coordinate,
/// 2. ECDH shared secret `S = auditor_private_key * R`,
/// 3. `private_key = enc_private_key - h(ENC_PRIVATE_KEY_TAG, S.x)`.
///
/// As with all x-only ECDH here, the y-parity chosen when recovering `R` is
/// irrelevant: `k*R` and `k*(-R)` share the same x-coordinate.
pub fn decrypt_enc_private_key(
    enc: &EncPrivateKey,
    auditor_private_key: &SecretFelt,
) -> Result<SecretFelt, DecryptionError> {
    let ephemeral_point = AffinePoint::new_from_x(&enc.ephemeral_pubkey, false)
        .ok_or(DecryptionError::InvalidEphemeralPubkey)?;
    let shared_point = &ephemeral_point * **auditor_private_key;
    let shared_x = shared_point.x();

    let private_key = enc.enc_private_key - compute_enc_private_key_hash(shared_x);
    Ok(SecretFelt::new(private_key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::load_cairo_ref_fixture;

    fn fixture_enc_private_key(f: &crate::test_fixtures::CairoRefFixture) -> EncPrivateKey {
        EncPrivateKey {
            auditor_public_key: f.inputs.auditor_public_key,
            ephemeral_pubkey: f.outputs.enc_private_key_ephemeral_pubkey,
            enc_private_key: f.outputs.enc_private_key_value,
        }
    }

    #[test]
    fn test_derive_public_key_with_cairo_vectors() {
        let f = load_cairo_ref_fixture();
        assert_eq!(
            derive_public_key(&f.inputs.recipient_private_key),
            f.inputs.recipient_public_key_derived
        );
        assert_eq!(
            derive_public_key(&SecretFelt::new(f.inputs.auditor_private_key)),
            f.inputs.auditor_public_key
        );
    }

    #[test]
    fn test_decrypt_enc_private_key_with_cairo_vectors() {
        let f = load_cairo_ref_fixture();
        let recovered = decrypt_enc_private_key(
            &fixture_enc_private_key(&f),
            &SecretFelt::new(f.inputs.auditor_private_key),
        )
        .expect("recovery should succeed");
        assert_eq!(*recovered, f.inputs.user_private_key);
    }

    /// The audit's consistency check: the public key derived from the recovered
    /// private key must equal the one derived from the true user private key.
    #[test]
    fn test_recovered_key_matches_registered_public_key() {
        let f = load_cairo_ref_fixture();
        let recovered = decrypt_enc_private_key(
            &fixture_enc_private_key(&f),
            &SecretFelt::new(f.inputs.auditor_private_key),
        )
        .unwrap();
        assert_eq!(
            derive_public_key(&recovered),
            derive_public_key(&SecretFelt::new(f.inputs.user_private_key))
        );
    }

    #[test]
    fn test_decrypt_enc_private_key_invalid_pubkey() {
        let enc = EncPrivateKey {
            auditor_public_key: Felt::ONE,
            ephemeral_pubkey: Felt::ZERO,
            enc_private_key: Felt::TWO,
        };
        let result = decrypt_enc_private_key(&enc, &SecretFelt::new(Felt::from(12345u64)));
        assert!(matches!(
            result,
            Err(DecryptionError::InvalidEphemeralPubkey)
        ));
    }
}
