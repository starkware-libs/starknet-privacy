//! Hash functions and domain separation tags.

use std::sync::LazyLock;

use starknet_crypto::{poseidon_hash_many, PoseidonHasher};
use starknet_types_core::felt::Felt;

/// Domain separation tag for encrypted channel key.
static ENC_CHANNEL_KEY_TAG: LazyLock<Felt> =
    LazyLock::new(|| short_string_to_felt("ENC_CHANNEL_KEY_TAG:V1"));

/// Domain separation tag for encrypted sender address.
static ENC_SENDER_ADDR_TAG: LazyLock<Felt> =
    LazyLock::new(|| short_string_to_felt("ENC_SENDER_ADDR_TAG:V1"));

/// Domain separation tag for subchannel key derivation.
static SUBCHANNEL_KEY_TAG: LazyLock<Felt> =
    LazyLock::new(|| short_string_to_felt("SUBCHANNEL_KEY_TAG:V1"));

/// Domain separation tag for encrypted token.
static ENC_TOKEN_TAG: LazyLock<Felt> = LazyLock::new(|| short_string_to_felt("ENC_TOKEN_TAG:V1"));

/// Domain separation tag for note ID derivation.
static NOTE_ID_TAG: LazyLock<Felt> = LazyLock::new(|| short_string_to_felt("NOTE_ID_TAG:V1"));

/// Domain separation tag for encrypted amount.
static ENC_AMOUNT_TAG: LazyLock<Felt> = LazyLock::new(|| short_string_to_felt("ENC_AMOUNT_TAG:V1"));

/// Converts a short string (up to 31 ASCII chars) to Felt.
fn short_string_to_felt(s: &str) -> Felt {
    assert!(
        s.len() <= 31,
        "short string must be at most 31 bytes, got {}",
        s.len()
    );
    Felt::from_bytes_be_slice(s.as_bytes())
}

/// Double Poseidon hash function.
pub fn hash(data: &[Felt]) -> Felt {
    let inner = poseidon_hash_many(data.iter());
    let mut hasher = PoseidonHasher::new();
    hasher.update(inner);
    hasher.finalize()
}

/// Computes the encryption mask for channel key.
pub fn compute_enc_channel_key_hash(shared_x: Felt) -> Felt {
    hash(&[*ENC_CHANNEL_KEY_TAG, shared_x])
}

/// Computes the encryption mask for sender address.
pub fn compute_enc_sender_addr_hash(shared_x: Felt) -> Felt {
    hash(&[*ENC_SENDER_ADDR_TAG, shared_x])
}

/// Computes the subchannel key from channel key and index.
///
/// `subchannel_key = hash(SUBCHANNEL_KEY_TAG, channel_key, index, 0)`
pub fn compute_subchannel_key(channel_key: Felt, index: u64) -> Felt {
    hash(&[
        *SUBCHANNEL_KEY_TAG,
        channel_key,
        Felt::from(index),
        Felt::ZERO,
    ])
}

/// Computes the encryption mask for token encryption.
///
/// `enc_token_hash = hash(ENC_TOKEN_TAG, channel_key, index, 0, salt)`
pub fn compute_enc_token_hash(channel_key: Felt, index: u64, salt: Felt) -> Felt {
    hash(&[
        *ENC_TOKEN_TAG,
        channel_key,
        Felt::from(index),
        Felt::ZERO,
        salt,
    ])
}

/// Computes the note ID from channel key, token, and note index.
///
/// `note_id = hash(NOTE_ID_TAG, channel_key, token, index, 0)`
pub fn compute_note_id(channel_key: Felt, token: Felt, index: u64) -> Felt {
    hash(&[
        *NOTE_ID_TAG,
        channel_key,
        token,
        Felt::from(index),
        Felt::ZERO,
    ])
}

/// Computes the encryption mask for note amount.
///
/// `enc_amount_hash = hash(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt)`
pub fn compute_enc_amount_hash(channel_key: Felt, token: Felt, index: u64, salt: u128) -> Felt {
    hash(&[
        *ENC_AMOUNT_TAG,
        channel_key,
        token,
        Felt::from(index),
        Felt::ZERO,
        Felt::from(salt),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::load_cairo_ref_fixture;

    #[test]
    fn test_short_string_to_felt() {
        let felt = short_string_to_felt("hello");
        assert_eq!(felt, Felt::from_hex_unchecked("0x68656c6c6f"));
    }

    #[test]
    fn test_hashes_with_cairo_vectors() {
        let f = load_cairo_ref_fixture();
        assert_eq!(
            compute_enc_channel_key_hash(f.inputs.shared_x),
            f.outputs.enc_channel_key_hash
        );
        assert_eq!(
            compute_enc_sender_addr_hash(f.inputs.shared_x),
            f.outputs.enc_sender_addr_hash
        );
    }

    #[test]
    fn test_compute_subchannel_key() {
        let f = load_cairo_ref_fixture();
        assert_eq!(
            compute_subchannel_key(f.inputs.channel_key, f.inputs.index),
            f.outputs.subchannel_key
        );
    }

    #[test]
    fn test_compute_enc_token_hash() {
        let f = load_cairo_ref_fixture();
        assert_eq!(
            compute_enc_token_hash(f.inputs.channel_key, f.inputs.index, f.inputs.salt),
            f.outputs.enc_token_hash
        );
    }

    #[test]
    fn test_compute_note_id() {
        let f = load_cairo_ref_fixture();
        assert_eq!(
            compute_note_id(f.inputs.channel_key, f.inputs.token, f.inputs.index),
            f.outputs.note_id
        );
    }

    #[test]
    fn test_compute_enc_amount_hash() {
        let f = load_cairo_ref_fixture();
        let salt = {
            let bytes = f.inputs.salt.to_bytes_be();
            u128::from_be_bytes(bytes[16..32].try_into().unwrap())
        };
        assert_eq!(
            compute_enc_amount_hash(f.inputs.channel_key, f.inputs.token, f.inputs.index, salt),
            f.outputs.enc_amount_hash
        );
    }
}
