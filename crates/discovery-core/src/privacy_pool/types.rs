//! Privacy pool specific types.
//!
//! This module contains the data structures used by the privacy pool contract,
//! including encrypted ciphertext types and decrypted plaintext types.

use std::fmt;
use std::ops::Deref;

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;
use zeroize::Zeroize;

/// Extracts low 128 bits from a Felt.
pub fn felt_low_u128(felt: Felt) -> u128 {
    let d = felt.to_le_digits();
    d[0] as u128 | (d[1] as u128) << 64
}

/// A Felt that automatically zeroes its memory on drop.
///
/// Implements `Deref<Target=Felt>` for transparent use where `&Felt` is expected.
///
/// Deliberately excludes `Copy` (silent copies of secrets are dangerous)
/// and `Serde` (keys should be wrapped at the system boundary, not
/// deserialized directly). `Debug` prints `[REDACTED]` to prevent
/// accidental logging of key material.
#[derive(Clone)]
pub struct SecretFelt(Felt);

impl SecretFelt {
    pub fn new(felt: Felt) -> Self {
        Self(felt)
    }
}

impl Deref for SecretFelt {
    type Target = Felt;
    fn deref(&self) -> &Felt {
        &self.0
    }
}

impl Zeroize for SecretFelt {
    fn zeroize(&mut self) {
        self.0 = Felt::ZERO;
    }
}

impl Drop for SecretFelt {
    fn drop(&mut self) {
        self.zeroize();
    }
}

impl fmt::Debug for SecretFelt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}

/// Serde helper: serializes `u128` as a decimal string to avoid
/// precision loss in JSON (JS numbers are 53-bit floats).
pub mod u128_as_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u128, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u128, D::Error> {
        let s: String = Deserialize::deserialize(deserializer)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

/// Serde helpers for `SecretFelt`. Use with `#[serde(serialize_with, deserialize_with)]`.
pub mod secret_felt_serde {
    use super::*;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S>(secret: &SecretFelt, s: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        Felt::serialize(&secret.0, s)
    }

    pub fn deserialize<'de, D>(d: D) -> Result<SecretFelt, D::Error>
    where
        D: Deserializer<'de>,
    {
        Felt::deserialize(d).map(SecretFelt::new)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_debug_redacts_value() {
        let secret = SecretFelt::new(Felt::from(42u64));
        let debug_output = format!("{:?}", secret);
        assert_eq!(debug_output, "[REDACTED]");
        assert!(!debug_output.contains("42"));
    }

    #[test]
    fn test_zeroize_on_drop() {
        let mut secret = SecretFelt::new(Felt::from(12345u64));
        assert_ne!(*secret, Felt::ZERO);
        secret.zeroize();
        assert_eq!(*secret, Felt::ZERO);
    }

    #[test]
    fn test_secret_felt_serde_roundtrip() {
        #[derive(Serialize, Deserialize)]
        struct Wrapper {
            #[serde(
                serialize_with = "secret_felt_serde::serialize",
                deserialize_with = "secret_felt_serde::deserialize"
            )]
            key: SecretFelt,
        }

        let original = Wrapper {
            key: SecretFelt::new(Felt::from(0xdeadbeefu64)),
        };
        let json = serde_json::to_string(&original).unwrap();
        let restored: Wrapper = serde_json::from_str(&json).unwrap();
        assert_eq!(*restored.key, *original.key);
    }

    #[test]
    fn test_u128_as_string_roundtrip() {
        #[derive(Serialize, Deserialize, PartialEq, Debug)]
        struct Wrapper {
            #[serde(with = "u128_as_string")]
            value: u128,
        }

        let cases = [0u128, 1, u128::MAX, 1u128 << 53, (1u128 << 53) + 1];
        for value in cases {
            let wrapper = Wrapper { value };
            let json = serde_json::to_string(&wrapper).unwrap();
            assert!(
                json.contains(&format!("\"{}\"", value)),
                "value {value} should be serialized as a string"
            );
            let restored: Wrapper = serde_json::from_str(&json).unwrap();
            assert_eq!(restored, wrapper);
        }
    }
}

/// Ciphertext for an ECDH-based encryption of channel data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncChannelInfo {
    /// Ephemeral ECDH public key x-coordinate (rG.x).
    pub ephemeral_pubkey: Felt,
    /// Encrypted channel key.
    pub enc_channel_key: Felt,
    /// Encrypted sender address.
    pub enc_sender_addr: Felt,
}

/// Ciphertext for an ECDH-based encryption of private key.
/// Used by the auditor to decrypt the user's private key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncPrivateKey {
    /// Auditor public key used for encryption.
    pub auditor_public_key: Felt,
    /// Ephemeral ECDH public key x-coordinate (rG.x).
    pub ephemeral_pubkey: Felt,
    /// Encrypted private key.
    pub enc_private_key: Felt,
}

/// Encrypted subchannel info.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncSubchannelInfo {
    /// Salt generated by the sender for one-time key usage.
    pub salt: Felt,
    /// Encrypted token.
    pub enc_token: Felt,
}

/// Decrypted channel information.
#[derive(Debug, Clone)]
pub struct ChannelInfo {
    /// The channel key.
    pub channel_key: SecretFelt,
    /// The sender's address.
    pub sender_addr: Felt,
}

/// Encrypted outgoing channel info stored in the contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncOutgoingChannelInfo {
    /// Salt generated by the sender for one-time key usage.
    pub salt: Felt,
    /// Encrypted recipient address.
    pub enc_recipient_addr: Felt,
}
