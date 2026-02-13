//! Storage backend abstraction and mock implementation.
//!
//! This module defines the storage access traits used by the privacy pool
//! discovery logic, and provides a mock backend for testing.

use std::collections::HashMap;

use async_trait::async_trait;
use starknet_core::types::BlockId;
use starknet_types_core::felt::Felt;
use thiserror::Error;

use crate::privacy_pool::views::IViews;

/// Errors that can occur during storage operations.
#[derive(Debug, Error)]
pub enum StorageError {
    /// Failed to convert value to u64.
    #[error("value is too large to convert to u64: {0}")]
    CastToU64Error(Felt),
    /// Backend-specific error.
    #[error("{0}")]
    Backend(#[source] Box<dyn std::error::Error + Send + Sync>),
    /// `read_slots` returned a different number of values than requested.
    #[error("slot count mismatch")]
    SlotCountMismatch,
}

/// Low-level storage access for reading raw storage slots.
#[async_trait]
pub trait RawStorageAccess: Send + Sync {
    /// Reads a single storage slot.
    async fn read_slot(&self, slot: Felt) -> Result<Felt, StorageError>;

    /// Reads multiple storage slots.
    ///
    /// The returned `Vec` must have the same length as `slots`.
    async fn read_slots(&self, slots: Vec<Felt>) -> Result<Vec<Felt>, StorageError>;
}

/// Factory for creating storage snapshots bound to a specific block.
#[async_trait]
pub trait StorageBackend: Send + Sync {
    /// The snapshot type produced by this backend.
    type Snapshot: StorageSnapshot;

    /// Creates a snapshot at the specified block for the given contract.
    /// If `block_id` is `None`, uses the latest block.
    async fn snapshot(&self, contract_address: Felt, block_id: Option<BlockId>) -> Self::Snapshot;
}

/// Consistent view of storage at a specific block.
#[async_trait]
pub trait StorageSnapshot: IViews {
    /// Returns the block ID this snapshot is bound to.
    fn block_id(&self) -> BlockId;
}

/// Mock storage backend backed by an in-memory HashMap.
///
/// Returns `Felt::ZERO` for any slot not in the map, mirroring the behavior of Cairo map.
#[derive(Clone)]
pub struct MockBackend {
    slots: HashMap<Felt, Felt>,
}

impl MockBackend {
    /// Creates a new mock backend with the given slot->value mapping.
    pub fn new(slots: HashMap<Felt, Felt>) -> Self {
        Self { slots }
    }

    /// Creates an empty mock backend.
    pub fn empty() -> Self {
        Self {
            slots: HashMap::new(),
        }
    }

    /// Inserts or replaces a slot->value pair into the mock storage.
    pub fn insert(&mut self, slot: Felt, value: Felt) {
        self.slots.insert(slot, value);
    }
}

#[async_trait]
impl RawStorageAccess for MockBackend {
    async fn read_slot(&self, slot: Felt) -> Result<Felt, StorageError> {
        Ok(self.slots.get(&slot).copied().unwrap_or(Felt::ZERO))
    }

    async fn read_slots(&self, slots: Vec<Felt>) -> Result<Vec<Felt>, StorageError> {
        Ok(slots
            .iter()
            .map(|s| self.slots.get(s).copied().unwrap_or(Felt::ZERO))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_mock_backend_empty() {
        let backend = MockBackend::empty();
        let value = backend.read_slot(Felt::ONE).await.unwrap();
        assert_eq!(value, Felt::ZERO);
    }

    #[tokio::test]
    async fn test_mock_backend_with_data() {
        let mut slots = HashMap::new();
        slots.insert(Felt::ONE, Felt::from(42u64));
        slots.insert(Felt::TWO, Felt::from(123u64));

        let backend = MockBackend::new(slots);

        assert_eq!(
            backend.read_slot(Felt::ONE).await.unwrap(),
            Felt::from(42u64)
        );
        assert_eq!(
            backend.read_slot(Felt::TWO).await.unwrap(),
            Felt::from(123u64)
        );
        assert_eq!(backend.read_slot(Felt::THREE).await.unwrap(), Felt::ZERO);
    }

    #[tokio::test]
    async fn test_mock_backend_read_slots() {
        let mut slots = HashMap::new();
        slots.insert(Felt::ONE, Felt::from(1u64));
        slots.insert(Felt::TWO, Felt::from(2u64));

        let backend = MockBackend::new(slots);

        let values = backend
            .read_slots(vec![Felt::ONE, Felt::TWO, Felt::THREE])
            .await
            .unwrap();

        assert_eq!(values, vec![Felt::from(1u64), Felt::from(2u64), Felt::ZERO]);
    }

    #[tokio::test]
    async fn test_mock_backend_insert() {
        let mut backend = MockBackend::empty();
        backend.insert(Felt::ONE, Felt::from(100u64));

        assert_eq!(
            backend.read_slot(Felt::ONE).await.unwrap(),
            Felt::from(100u64)
        );
    }
}
