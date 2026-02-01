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

/// Cryptographic hash function.
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
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Inputs {
        shared_x: Felt,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Outputs {
        enc_channel_key_hash: Felt,
        enc_sender_addr_hash: Felt,
    }

    #[derive(Deserialize)]
    struct Fixture {
        inputs: Inputs,
        outputs: Outputs,
    }

    fn load_fixture() -> Fixture {
        const JSON: &str = include_str!("../tests/fixtures/cairo-reference-data.json");
        serde_json::from_str(JSON).expect("failed to parse fixture")
    }

    #[test]
    fn test_short_string_to_felt() {
        let felt = short_string_to_felt("hello");
        assert_eq!(felt, Felt::from_hex_unchecked("0x68656c6c6f"));
    }

    #[test]
    fn test_hashes_with_cairo_vectors() {
        let f = load_fixture();
        assert_eq!(
            compute_enc_channel_key_hash(f.inputs.shared_x),
            f.outputs.enc_channel_key_hash
        );
        assert_eq!(
            compute_enc_sender_addr_hash(f.inputs.shared_x),
            f.outputs.enc_sender_addr_hash
        );
    }
}
