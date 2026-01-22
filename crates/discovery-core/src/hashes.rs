//! Hash functions and domain separation tags.

use std::sync::LazyLock;

use starknet_crypto::{poseidon_hash_many, PoseidonHasher};
use starknet_types_core::felt::Felt;

/// Domain separation tag for encrypted channel key.
static ENC_CHANNEL_KEY_TAG: LazyLock<Felt> =
    LazyLock::new(|| short_string_to_felt("channel_info:enc_channel_key:v1"));

/// Domain separation tag for encrypted sender address.
static ENC_SENDER_ADDR_TAG: LazyLock<Felt> =
    LazyLock::new(|| short_string_to_felt("channel_info:enc_sender_addr:v1"));

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
        let shared_x = Felt::from_hex_unchecked(
            "0x298993a56bda2a7db1b9aae6cbcd1bbb6d7369a72d29a8c92600ed20c0e750e",
        );
        assert_eq!(
            compute_enc_channel_key_hash(shared_x),
            Felt::from_hex_unchecked(
                "0x2ae7f662a02ce3686f93fc30afc3712ec1e83b38b01398a990b98ea1b5faa04"
            )
        );
    }

    #[test]
    fn test_compute_enc_sender_addr_hash() {
        let shared_x = Felt::from_hex_unchecked(
            "0x298993a56bda2a7db1b9aae6cbcd1bbb6d7369a72d29a8c92600ed20c0e750e",
        );
        assert_eq!(
            compute_enc_sender_addr_hash(shared_x),
            Felt::from_hex_unchecked(
                "0x144fc170cdf653e10b83f509757a89815a2b3cffc0fa0dd5a7aec7684ce0520"
            )
        );
    }
}
