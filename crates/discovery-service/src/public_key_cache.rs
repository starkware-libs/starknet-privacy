//! Lock-free concurrent cache for on-chain public keys.
//!
//! Keyed by `(contract_address, user_address)`. Public keys are immutable
//! once registered on-chain, so cache entries never go stale. Zero (unregistered)
//! values are not cached because the user may register later.

use moka::sync::Cache;
use starknet_core::types::Felt;

/// Concurrent cache for registered public keys fetched from the contract.
pub struct PublicKeyCache {
    cache: Cache<(Felt, Felt), Felt>,
}

impl PublicKeyCache {
    /// Creates a new cache with the given maximum entry capacity.
    pub fn new(capacity: u64) -> Self {
        Self {
            cache: Cache::new(capacity),
        }
    }

    /// Returns the cached public key for `(contract_address, user_address)`, if present.
    pub fn get(&self, contract_address: Felt, user_address: Felt) -> Option<Felt> {
        self.cache.get(&(contract_address, user_address))
    }

    /// Stores a public key. Zero values are skipped (unregistered users may register later).
    pub fn insert(&self, contract_address: Felt, user_address: Felt, public_key: Felt) {
        if public_key != Felt::ZERO {
            self.cache
                .insert((contract_address, user_address), public_key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_insert_and_get_round_trip() {
        let cache = PublicKeyCache::new(100);
        let contract_address = Felt::from_hex_unchecked("0x1");
        let user_address = Felt::from_hex_unchecked("0x2");
        let public_key = Felt::from_hex_unchecked("0xabc");

        cache.insert(contract_address, user_address, public_key);
        assert_eq!(cache.get(contract_address, user_address), Some(public_key));
    }

    #[test]
    fn test_cache_miss_returns_none() {
        let cache = PublicKeyCache::new(100);
        let contract_address = Felt::from_hex_unchecked("0x1");
        let user_address = Felt::from_hex_unchecked("0x2");

        assert_eq!(cache.get(contract_address, user_address), None);
    }

    #[test]
    fn test_zero_values_not_cached() {
        let cache = PublicKeyCache::new(100);
        let contract_address = Felt::from_hex_unchecked("0x1");
        let user_address = Felt::from_hex_unchecked("0x2");

        cache.insert(contract_address, user_address, Felt::ZERO);
        assert_eq!(cache.get(contract_address, user_address), None);
    }

    #[test]
    fn test_different_keys_are_independent() {
        let cache = PublicKeyCache::new(100);
        let contract_address = Felt::from_hex_unchecked("0x1");
        let user_a = Felt::from_hex_unchecked("0x2");
        let user_b = Felt::from_hex_unchecked("0x3");
        let public_key_a = Felt::from_hex_unchecked("0xaa");
        let public_key_b = Felt::from_hex_unchecked("0xbb");

        cache.insert(contract_address, user_a, public_key_a);
        cache.insert(contract_address, user_b, public_key_b);

        assert_eq!(cache.get(contract_address, user_a), Some(public_key_a));
        assert_eq!(cache.get(contract_address, user_b), Some(public_key_b));
    }
}
