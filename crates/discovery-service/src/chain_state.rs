//! Chain state tracking for the Starknet indexer.

use std::collections::{BTreeMap, VecDeque};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use starknet_core::types::{Felt, ReorgData};
use starknet_providers::ProviderError;
use thiserror::Error;

/// Canonical block hashes retained per new-heads subscription. At a few seconds
/// per Starknet block this covers roughly the last hour of chain history — far
/// deeper than any observed reorg — for roughly 40 KiB of hashes.
pub const MAX_TRACKED_CANONICAL_BLOCKS: usize = 1024;

/// Orphaned block hashes retained per new-heads subscription. Sized to absorb a
/// reorg that orphans the entire tracked window; beyond that the oldest hashes
/// are dropped and answered by the node instead.
pub const MAX_TRACKED_ORPHANED_BLOCKS: usize = 1024;

/// Represents the current chain head.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChainHead {
    pub block_number: u64,
    pub block_hash: Felt,
    pub timestamp: u64,
}

/// Bounded record of what a node's new-heads subscription said about the recent
/// chain tip: the hash announced as canonical at each height, and the hashes
/// since named in a reorg notification.
///
/// A hash the window does not cover is reported as unknown, never as orphaned —
/// reporting an evicted entry as orphaned would force every client holding an
/// older cursor to re-sync. Treating an announced hash as canonical assumes the
/// node reports every range it takes back; see specs/11-reorg-handling.md §11.1.
///
/// Every value comes from an external node, so both collections are hard capped.
#[derive(Debug, Default)]
pub struct RecentBlockWindow {
    /// Announced block hash per block number, ordered by height so the oldest
    /// entry is the one evicted and a reorged range is cheap to cut out.
    canonical_hashes: BTreeMap<u64, Felt>,
    /// Hashes named by reorg notifications, oldest first.
    orphaned_hashes: VecDeque<Felt>,
}

impl RecentBlockWindow {
    /// Records `head` as the announced canonical block at its height.
    ///
    /// Entries at or above that height are superseded, and are dropped rather
    /// than orphaned so they go back to being resolved against the node.
    pub fn record_head(&mut self, head: &ChainHead) {
        self.canonical_hashes.split_off(&head.block_number);
        self.canonical_hashes
            .insert(head.block_number, head.block_hash);
        // An announcement outranks any earlier reorg naming the same hash.
        self.orphaned_hashes
            .retain(|orphaned_hash| *orphaned_hash != head.block_hash);

        while self.canonical_hashes.len() > MAX_TRACKED_CANONICAL_BLOCKS {
            self.canonical_hashes.pop_first();
        }
    }

    /// Records the block range a reorg notification names as orphaned.
    ///
    /// Heights between the two named ends come from what the window already
    /// tracks, so a range spanning the whole `u64` space costs no extra work.
    pub fn record_reorg(&mut self, reorg: &ReorgData) {
        let orphaned_block_numbers: Vec<u64> = self
            .canonical_hashes
            .range(lowest_orphaned_block_number(reorg)..=highest_orphaned_block_number(reorg))
            .map(|(block_number, _)| *block_number)
            .collect();

        for block_number in orphaned_block_numbers {
            if let Some(block_hash) = self.canonical_hashes.remove(&block_number) {
                self.record_orphaned_hash(block_hash);
            }
        }
        // Last, so the node's own hashes outlive window-inferred ones on eviction.
        self.record_orphaned_hash(reorg.starting_block_hash);
        self.record_orphaned_hash(reorg.ending_block_hash);
    }

    /// Forgets everything tracked.
    pub fn clear(&mut self) {
        self.canonical_hashes.clear();
        self.orphaned_hashes.clear();
    }

    /// Canonicity of `block_hash` according to tracked notifications alone.
    ///
    /// - `Some(true)`: announced as the canonical block at its height and not
    ///   named by a reorg since.
    /// - `Some(false)`: named by a reorg notification.
    /// - `None`: not covered by the window (never announced, or evicted), so the
    ///   answer has to come from the node.
    pub fn canonicity(&self, block_hash: Felt) -> Option<bool> {
        if self.orphaned_hashes.contains(&block_hash) {
            return Some(false);
        }
        self.canonical_hashes
            .values()
            .any(|canonical_hash| *canonical_hash == block_hash)
            .then_some(true)
    }

    fn record_orphaned_hash(&mut self, block_hash: Felt) {
        if self.orphaned_hashes.contains(&block_hash) {
            return;
        }
        self.orphaned_hashes.push_back(block_hash);
        while self.orphaned_hashes.len() > MAX_TRACKED_ORPHANED_BLOCKS {
            self.orphaned_hashes.pop_front();
        }
    }
}

/// Lowest block number a reorg notification covers. The pair is taken as
/// unordered, so an inverted range still yields a usable bound instead of
/// panicking on a reversed lookup.
pub fn lowest_orphaned_block_number(reorg: &ReorgData) -> u64 {
    reorg.starting_block_number.min(reorg.ending_block_number)
}

/// Highest block number a reorg notification covers.
fn highest_orphaned_block_number(reorg: &ReorgData) -> u64 {
    reorg.starting_block_number.max(reorg.ending_block_number)
}

/// Errors that can occur during chain state operations.
#[derive(Debug, Error)]
pub enum ChainStateError {
    #[error("RPC request failed: {0}")]
    RpcError(#[source] ProviderError),
}

/// Trait for tracking chain state and verifying block canonicity.
#[async_trait]
pub trait ChainState: Send + Sync {
    /// Get the current chain head, if known.
    async fn get_head(&self) -> Option<ChainHead>;

    /// Set the current chain head, as announced by the node.
    async fn set_head(&self, head: ChainHead);

    /// Record a reorg the node reported over its new-heads subscription.
    ///
    /// The reported range is the node's own verdict on which blocks left the
    /// canonical chain, so the hashes it covers are answered by
    /// [`ChainState::is_canonical`] without asking the node again.
    async fn record_reorg(&self, reorg: &ReorgData);

    /// Forget everything learned from a new-heads subscription, including the
    /// cached head.
    ///
    /// Must be called when a subscription is lost, not when one starts: a block
    /// orphaned while nothing was subscribed produces no notification, so every
    /// hash the dead stream announced is unverifiable from that instant on.
    async fn forget_recent_blocks(&self);

    /// Check whether `block_hash` is the block the chain carries at its height.
    ///
    /// Canonicity is not existence: a node keeps serving an orphaned block by
    /// hash. `Err` means the node could not answer, which is neither verdict.
    async fn is_canonical(&self, block_hash: Felt) -> Result<bool, ChainStateError>;
}

#[cfg(test)]
pub mod mock {
    use std::sync::Mutex;

    use super::*;

    /// Mock chain state for testing. `canonical_blocks` stands in for the node,
    /// answering whatever the tracked window has no verdict on.
    pub struct MockChainState {
        head: Option<ChainHead>,
        canonical_blocks: Vec<Felt>,
        recent_blocks: Mutex<RecentBlockWindow>,
    }

    impl MockChainState {
        pub fn new() -> Self {
            Self {
                head: Some(ChainHead {
                    block_number: 100,
                    block_hash: Felt::from_hex_unchecked("0x123"),
                    timestamp: 1000,
                }),
                canonical_blocks: vec![Felt::from_hex_unchecked("0x123")],
                recent_blocks: Mutex::new(RecentBlockWindow::default()),
            }
        }

        pub fn with_no_head() -> Self {
            Self {
                head: None,
                canonical_blocks: vec![],
                recent_blocks: Mutex::new(RecentBlockWindow::default()),
            }
        }

        fn recent_blocks(&self) -> std::sync::MutexGuard<'_, RecentBlockWindow> {
            self.recent_blocks.lock().expect("recent blocks lock")
        }
    }

    impl Default for MockChainState {
        fn default() -> Self {
            Self::new()
        }
    }

    #[async_trait]
    impl ChainState for MockChainState {
        async fn get_head(&self) -> Option<ChainHead> {
            self.head
        }

        async fn set_head(&self, head: ChainHead) {
            // The mock's head is fixed at construction; only tracking is exercised.
            self.recent_blocks().record_head(&head);
        }

        async fn record_reorg(&self, reorg: &ReorgData) {
            self.recent_blocks().record_reorg(reorg);
        }

        async fn forget_recent_blocks(&self) {
            self.recent_blocks().clear();
        }

        async fn is_canonical(&self, block_hash: Felt) -> Result<bool, ChainStateError> {
            let tracked_canonicity = self.recent_blocks().canonicity(block_hash);
            Ok(tracked_canonicity.unwrap_or_else(|| self.canonical_blocks.contains(&block_hash)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORPHANED_HASH: Felt = Felt::from_hex_unchecked("0xaaa");
    const REPLACEMENT_HASH: Felt = Felt::from_hex_unchecked("0xbbb");

    fn head_at(block_number: u64, block_hash: Felt) -> ChainHead {
        ChainHead {
            block_number,
            block_hash,
            timestamp: 1_700_000_000 + block_number,
        }
    }

    fn reorg_between(
        starting_block_number: u64,
        starting_block_hash: Felt,
        ending_block_number: u64,
        ending_block_hash: Felt,
    ) -> ReorgData {
        ReorgData {
            starting_block_hash,
            starting_block_number,
            ending_block_hash,
            ending_block_number,
        }
    }

    #[test]
    fn test_announced_head_is_canonical() {
        let mut window = RecentBlockWindow::default();
        window.record_head(&head_at(100, ORPHANED_HASH));

        assert_eq!(window.canonicity(ORPHANED_HASH), Some(true));
    }

    #[test]
    fn test_unknown_hash_has_no_verdict() {
        let mut window = RecentBlockWindow::default();
        window.record_head(&head_at(100, ORPHANED_HASH));

        assert_eq!(window.canonicity(REPLACEMENT_HASH), None);
    }

    #[test]
    fn test_reorg_marks_announced_hash_orphaned() {
        let mut window = RecentBlockWindow::default();
        window.record_head(&head_at(99, REPLACEMENT_HASH));
        window.record_head(&head_at(100, ORPHANED_HASH));

        window.record_reorg(&reorg_between(100, ORPHANED_HASH, 100, ORPHANED_HASH));

        assert_eq!(window.canonicity(ORPHANED_HASH), Some(false));
        assert_eq!(
            window.canonicity(REPLACEMENT_HASH),
            Some(true),
            "blocks below the reorged range stay canonical"
        );
    }

    #[test]
    fn test_reorg_marks_named_hashes_never_announced() {
        let mut window = RecentBlockWindow::default();

        window.record_reorg(&reorg_between(100, ORPHANED_HASH, 105, REPLACEMENT_HASH));

        assert_eq!(window.canonicity(ORPHANED_HASH), Some(false));
        assert_eq!(window.canonicity(REPLACEMENT_HASH), Some(false));
    }

    #[test]
    fn test_reorg_spanning_whole_number_space_is_bounded() {
        let mut window = RecentBlockWindow::default();
        for block_number in 0..10u64 {
            window.record_head(&head_at(block_number, Felt::from(block_number)));
        }

        window.record_reorg(&reorg_between(0, ORPHANED_HASH, u64::MAX, REPLACEMENT_HASH));

        for block_number in 0..10u64 {
            assert_eq!(
                window.canonicity(Felt::from(block_number)),
                Some(false),
                "block {block_number} is inside the reorged range"
            );
        }
    }

    #[test]
    fn test_inverted_reorg_range_is_accepted() {
        let mut window = RecentBlockWindow::default();
        window.record_head(&head_at(100, ORPHANED_HASH));

        // The node is expected to order the pair; an inverted range must still
        // be interpreted rather than panic on a reversed lookup.
        window.record_reorg(&reorg_between(105, REPLACEMENT_HASH, 100, ORPHANED_HASH));

        assert_eq!(window.canonicity(ORPHANED_HASH), Some(false));
    }

    #[test]
    fn test_re_announced_head_clears_orphaned_verdict() {
        let mut window = RecentBlockWindow::default();
        window.record_reorg(&reorg_between(100, ORPHANED_HASH, 100, ORPHANED_HASH));

        window.record_head(&head_at(100, ORPHANED_HASH));

        assert_eq!(window.canonicity(ORPHANED_HASH), Some(true));
    }

    #[test]
    fn test_superseded_height_loses_its_verdict() {
        let mut window = RecentBlockWindow::default();
        window.record_head(&head_at(100, ORPHANED_HASH));

        // A second announcement at the same height supersedes the first without
        // proving it orphaned, so the old hash goes back to the node.
        window.record_head(&head_at(100, REPLACEMENT_HASH));

        assert_eq!(window.canonicity(ORPHANED_HASH), None);
        assert_eq!(window.canonicity(REPLACEMENT_HASH), Some(true));
    }

    #[test]
    fn test_window_evicts_oldest_and_stays_capped() {
        let mut window = RecentBlockWindow::default();
        let num_announced_heads = (MAX_TRACKED_CANONICAL_BLOCKS as u64) * 3;
        for block_number in 0..num_announced_heads {
            window.record_head(&head_at(block_number, Felt::from(block_number + 1)));
        }

        assert_eq!(
            window.canonical_hashes.len(),
            MAX_TRACKED_CANONICAL_BLOCKS,
            "the window must stay at its cap however many heads arrive"
        );
        assert_eq!(
            window.canonicity(Felt::from(1u64)),
            None,
            "an evicted hash must fall back to the node, not be called orphaned"
        );
        assert_eq!(
            window.canonicity(Felt::from(num_announced_heads)),
            Some(true),
            "the newest announced head stays covered"
        );
    }

    #[test]
    fn test_orphaned_hashes_stay_capped() {
        let mut window = RecentBlockWindow::default();
        for block_number in 0..(MAX_TRACKED_ORPHANED_BLOCKS as u64) * 3 {
            let block_hash = Felt::from(block_number + 1);
            window.record_head(&head_at(block_number, block_hash));
            window.record_reorg(&reorg_between(
                block_number,
                block_hash,
                block_number,
                block_hash,
            ));
        }

        assert_eq!(
            window.orphaned_hashes.len(),
            MAX_TRACKED_ORPHANED_BLOCKS,
            "orphaned hashes must stay at their cap however many reorgs arrive"
        );
        assert_eq!(
            window.canonicity(Felt::from(1u64)),
            None,
            "an evicted orphaned hash falls back to the node"
        );
    }

    #[test]
    fn test_clear_drops_every_verdict() {
        let mut window = RecentBlockWindow::default();
        window.record_head(&head_at(100, REPLACEMENT_HASH));
        window.record_reorg(&reorg_between(101, ORPHANED_HASH, 101, ORPHANED_HASH));

        window.clear();

        assert_eq!(window.canonicity(REPLACEMENT_HASH), None);
        assert_eq!(window.canonicity(ORPHANED_HASH), None);
    }
}
