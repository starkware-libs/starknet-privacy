//! Event backend abstraction and mock implementation.
//!
//! Mirrors [`crate::storage_backend`] for event access: defines the raw event
//! access trait and a mock backend for testing.

use async_trait::async_trait;
pub use starknet_core::types::EmittedEvent;
use starknet_types_core::felt::Felt;

use crate::storage_backend::StorageError;

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
}

#[cfg(test)]
/// Mock event backend backed by an in-memory `Vec<EmittedEvent>`.
#[derive(Clone, Default)]
pub struct MockEventBackend {
    events: Vec<EmittedEvent>,
}

#[cfg(test)]
impl MockEventBackend {
    pub fn new(events: Vec<EmittedEvent>) -> Self {
        Self { events }
    }

    pub fn empty() -> Self {
        Self::default()
    }
}

#[cfg(test)]
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
                let block = event.block_number.unwrap_or(0);
                block >= from_block
                    && block <= to_block
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
}

#[cfg(test)]
/// Creates an `EmittedEvent` for use in tests.
///
/// Sets `from_address` and `block_hash` to default values since mock
/// tests typically don't need them.
pub fn mock_event(
    block_number: u64,
    transaction_hash: Felt,
    keys: Vec<Felt>,
    data: Vec<Felt>,
) -> EmittedEvent {
    EmittedEvent {
        from_address: Felt::ZERO,
        keys,
        data,
        block_hash: None,
        block_number: Some(block_number),
        transaction_hash,
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
            mock_event(5, Felt::from(0x1u64), vec![Felt::from(0xAu64)], vec![]),
            mock_event(15, Felt::from(0x2u64), vec![Felt::from(0xBu64)], vec![]),
            mock_event(25, Felt::from(0x3u64), vec![Felt::from(0xCu64)], vec![]),
        ]);

        let events = backend.get_events(&[], 5, 15).await.unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].block_number, Some(5));
        assert_eq!(events[1].block_number, Some(15));
    }

    #[tokio::test]
    async fn key_filtering_matches_correct_events() {
        let selector_a = Felt::from(0xAAu64);
        let selector_b = Felt::from(0xBBu64);
        let user = Felt::from(0x1u64);

        let backend = MockEventBackend::new(vec![
            mock_event(10, Felt::from(0x1u64), vec![selector_a, user], vec![]),
            mock_event(10, Felt::from(0x2u64), vec![selector_b, user], vec![]),
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
}
