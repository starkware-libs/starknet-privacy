//! Event backend abstraction and mock implementation.
//!
//! Mirrors [`crate::storage_backend`] for event access: defines the raw event
//! access trait and a mock backend for testing.

use async_trait::async_trait;
use starknet_types_core::felt::Felt;

use crate::storage_backend::StorageError;

/// A raw contract event with block context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmittedEvent {
    pub block_number: u64,
    pub transaction_hash: Felt,
    pub keys: Vec<Felt>,
    pub data: Vec<Felt>,
}

/// Low-level event access for reading contract events.
#[async_trait]
pub trait RawEventAccess: Send + Sync {
    /// Fetches events matching the given key filters within a block range (inclusive).
    ///
    /// Each element of `keys` is a set of accepted values for that key position.
    /// An event matches if, for every non-empty filter, the event's key at that
    /// position is contained in the filter set.
    async fn get_events(
        &self,
        keys: &[Vec<Felt>],
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<EmittedEvent>, StorageError>;

    /// Fetches all events emitted in the given transaction.
    async fn get_transaction_events(
        &self,
        transaction_hash: Felt,
    ) -> Result<Vec<EmittedEvent>, StorageError>;
}

/// Mock event backend backed by an in-memory `Vec<EmittedEvent>`.
#[derive(Clone, Default)]
pub struct MockEventBackend {
    events: Vec<EmittedEvent>,
}

impl MockEventBackend {
    pub fn new(events: Vec<EmittedEvent>) -> Self {
        Self { events }
    }

    pub fn empty() -> Self {
        Self::default()
    }
}

#[async_trait]
impl RawEventAccess for MockEventBackend {
    async fn get_events(
        &self,
        keys: &[Vec<Felt>],
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<EmittedEvent>, StorageError> {
        Ok(self
            .events
            .iter()
            .filter(|event| {
                event.block_number >= from_block
                    && event.block_number <= to_block
                    && keys.iter().enumerate().all(|(position, accepted)| {
                        accepted.is_empty()
                            || event
                                .keys
                                .get(position)
                                .is_some_and(|key| accepted.contains(key))
                    })
            })
            .cloned()
            .collect())
    }

    async fn get_transaction_events(
        &self,
        transaction_hash: Felt,
    ) -> Result<Vec<EmittedEvent>, StorageError> {
        Ok(self
            .events
            .iter()
            .filter(|event| event.transaction_hash == transaction_hash)
            .cloned()
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_mock_returns_no_events() {
        let backend = MockEventBackend::empty();
        let events = backend.get_events(&[], 0, 100).await.unwrap();
        assert!(events.is_empty());
    }

    #[tokio::test]
    async fn stored_events_returned_in_block_range() {
        let backend = MockEventBackend::new(vec![
            EmittedEvent {
                block_number: 5,
                transaction_hash: Felt::from(0x1u64),
                keys: vec![Felt::from(0xAu64)],
                data: vec![],
            },
            EmittedEvent {
                block_number: 15,
                transaction_hash: Felt::from(0x2u64),
                keys: vec![Felt::from(0xBu64)],
                data: vec![],
            },
            EmittedEvent {
                block_number: 25,
                transaction_hash: Felt::from(0x3u64),
                keys: vec![Felt::from(0xCu64)],
                data: vec![],
            },
        ]);

        let events = backend.get_events(&[], 5, 15).await.unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].block_number, 5);
        assert_eq!(events[1].block_number, 15);
    }

    #[tokio::test]
    async fn key_filtering_matches_correct_events() {
        let selector_a = Felt::from(0xAAu64);
        let selector_b = Felt::from(0xBBu64);
        let user = Felt::from(0x1u64);

        let backend = MockEventBackend::new(vec![
            EmittedEvent {
                block_number: 10,
                transaction_hash: Felt::from(0x1u64),
                keys: vec![selector_a, user],
                data: vec![],
            },
            EmittedEvent {
                block_number: 10,
                transaction_hash: Felt::from(0x2u64),
                keys: vec![selector_b, user],
                data: vec![],
            },
        ]);

        // Filter by selector_a at position 0
        let events = backend
            .get_events(&[vec![selector_a]], 0, 100)
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].keys[0], selector_a);

        // Filter by user at position 1 (any selector)
        let events = backend
            .get_events(&[vec![], vec![user]], 0, 100)
            .await
            .unwrap();
        assert_eq!(events.len(), 2);
    }

    #[tokio::test]
    async fn transaction_event_lookup() {
        let target_tx = Felt::from(0x42u64);
        let other_tx = Felt::from(0x99u64);

        let backend = MockEventBackend::new(vec![
            EmittedEvent {
                block_number: 10,
                transaction_hash: target_tx,
                keys: vec![Felt::ONE],
                data: vec![Felt::TWO],
            },
            EmittedEvent {
                block_number: 10,
                transaction_hash: other_tx,
                keys: vec![Felt::THREE],
                data: vec![],
            },
            EmittedEvent {
                block_number: 20,
                transaction_hash: target_tx,
                keys: vec![Felt::from(0x4u64)],
                data: vec![],
            },
        ]);

        let events = backend.get_transaction_events(target_tx).await.unwrap();
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.transaction_hash == target_tx));

        let events = backend
            .get_transaction_events(Felt::from(0xDEADu64))
            .await
            .unwrap();
        assert!(events.is_empty());
    }
}
