//! Privacy pool crypto primitives and storage slot computation.

use starknet_types_core::felt::Felt;

pub mod decryption;
pub mod hashes;
pub mod storage_slots;
pub mod types;
pub mod views;

/// Formats a `Felt` as a 0x-prefixed, zero-padded 64-char hex string.
///
/// Useful for logging — `Display`/`%` on `Felt` uses decimal, which is unreadable
/// for addresses and keys.
pub fn felt_hex(f: &Felt) -> String {
    format!("{:#066x}", f)
}
