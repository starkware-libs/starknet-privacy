//! Event backend abstraction and mock implementation.
//!
//! Mirrors [`crate::storage_backend`] for event access: defines the raw event
//! access trait and a mock backend for testing.

use async_trait::async_trait;
use starknet_core::types::BlockId;
pub use starknet_core::types::EmittedEvent;
use starknet_types_core::felt::Felt;

use crate::storage_backend::StorageError;

/// Low-level event access for reading contract events.
#[async_trait]
pub trait RawEventAccess: Send + Sync {
    /// Fetches all events matching the given key filters within a block range.
    ///
    /// Each element of `keys` is a set of accepted values for that key position.
    /// An event matches if, for every non-empty filter, the event's key at that
    /// position is contained in the filter set.
    ///
    /// Implementations drain the RPC's continuation-token pagination internally
    /// and return the fully-accumulated list. Callers who want bounded work per
    /// call should keep the block range small (≤ [`event_page_size`](Self::event_page_size)
    /// blocks) — under the sparse-user assumption, that bound produces exactly
    /// one RPC page.
    async fn get_events(
        &self,
        keys: &[Vec<Felt>],
        from_block: BlockId,
        to_block: BlockId,
    ) -> Result<Vec<EmittedEvent>, StorageError>;

    /// Returns the `BlockId` this view is pinned to (number, hash, or tag).
    ///
    /// Use this for RPC queries that need to preserve tag semantics (e.g.
    /// `Tag(PreConfirmed)` to include pre-confirmed events).
    fn block_id(&self) -> BlockId;

    /// Returns the concrete block number this view is pinned to.
    ///
    /// Resolved once at snapshot creation and stable thereafter. Used as an
    /// upper-bound estimator for event-range cost accounting.
    fn block_number(&self) -> u64;

    /// Returns the RPC's configured events-page size (max events per
    /// `starknet_getEvents` call). Orchestrators use this to size reverse-order
    /// block sub-ranges so each `get_events` call typically resolves in a
    /// single underlying RPC page.
    fn event_page_size(&self) -> usize;
}

#[cfg(test)]
/// Mock event backend backed by an in-memory `Vec<EmittedEvent>`.
///
/// The mock pretends to be pinned to a fixed block number (`MOCK_BLOCK_NUMBER`)
/// — large enough that all test ranges are valid against it.
#[derive(Clone, Default)]
pub struct MockEventBackend {
    events: Vec<EmittedEvent>,
}

#[cfg(test)]
const MOCK_BLOCK_NUMBER: u64 = 1_000;

#[cfg(test)]
pub const MOCK_EVENT_PAGE_SIZE: usize = 1024;

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
        from_block: BlockId,
        to_block: BlockId,
    ) -> Result<Vec<EmittedEvent>, StorageError> {
        let from = match from_block {
            BlockId::Number(n) => n,
            _ => 0,
        };
        let to = match to_block {
            BlockId::Number(n) => n,
            _ => u64::MAX,
        };
        Ok(self
            .events
            .iter()
            .filter(|event| {
                let block = event.block_number.unwrap_or(0);
                block >= from
                    && block <= to
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

    fn block_id(&self) -> BlockId {
        BlockId::Number(MOCK_BLOCK_NUMBER)
    }

    fn block_number(&self) -> u64 {
        MOCK_BLOCK_NUMBER
    }

    fn event_page_size(&self) -> usize {
        MOCK_EVENT_PAGE_SIZE
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
        event_index: 0,
        transaction_index: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_mock_returns_no_events() {
        let backend = MockEventBackend::empty();
        let events = backend
            .get_events(&[], BlockId::Number(0), BlockId::Number(100))
            .await
            .unwrap();
        assert!(events.is_empty());
    }

    #[tokio::test]
    async fn stored_events_returned_in_block_range() {
        let backend = MockEventBackend::new(vec![
            mock_event(5, Felt::from(0x1u64), vec![Felt::from(0xAu64)], vec![]),
            mock_event(15, Felt::from(0x2u64), vec![Felt::from(0xBu64)], vec![]),
            mock_event(25, Felt::from(0x3u64), vec![Felt::from(0xCu64)], vec![]),
        ]);

        let events = backend
            .get_events(&[], BlockId::Number(5), BlockId::Number(15))
            .await
            .unwrap();
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
            .get_events(
                &[vec![selector_a]],
                BlockId::Number(0),
                BlockId::Number(100),
            )
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].keys[0], selector_a);

        // Filter by user at position 1 (any selector)
        let events = backend
            .get_events(
                &[vec![], vec![user]],
                BlockId::Number(0),
                BlockId::Number(100),
            )
            .await
            .unwrap();
        assert_eq!(events.len(), 2);
    }
}
