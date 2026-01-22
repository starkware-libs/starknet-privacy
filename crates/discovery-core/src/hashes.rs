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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_short_string_to_felt() {
        let felt = short_string_to_felt("hello");
        // "hello" in hex is 0x68656c6c6f
        assert_eq!(felt, Felt::from_hex_unchecked("0x68656c6c6f"));
    }

    #[test]
    fn test_compute_enc_channel_key_hash() {
        let shared_x = Felt::from_hex_unchecked("0xaaa");
        assert_eq!(
            compute_enc_channel_key_hash(shared_x),
            Felt::from_hex_unchecked(
                "0xb55dfa5d9ab64940f495878f20f8a38f71180b9d5a15288f897f443078ba04"
            )
        );
    }

    #[test]
    fn test_compute_enc_sender_addr_hash() {
        let shared_x = Felt::from_hex_unchecked("0xaaa");
        assert_eq!(
            compute_enc_sender_addr_hash(shared_x),
            Felt::from_hex_unchecked(
                "0x6cf18657a71b146c29f2448d75dd899b57085759e6b1e06090d96c18f77d4b9"
            )
        );
    }
}
