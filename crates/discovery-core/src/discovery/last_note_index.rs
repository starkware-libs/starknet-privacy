//! Note index boundary probing.
//!
//! Finds the last note index in a subchannel via exponential search + bisection.
//! No decryption, no nullifier checks — just probes note existence.
//!
//! We assume an exponential distribution of note counts (most users have very
//! few notes), so exponential search finds the boundary quickly in the common case.

use std::future::Future;

use starknet_types_core::felt::Felt;

use super::cursor::SubchannelCursor;
use super::DiscoveryError;
use super::COST_NOTE_PROBING;
use crate::io_budget::IoBudget;
use crate::privacy_pool::hashes::compute_note_id;
use crate::privacy_pool::views::IViews;

/// Finds the last note index via [`exponential_ascend`] + [`bisect_boundary`].
///
/// Runs in two phases, resumable via cursor:
/// 1. **Ascending**: exponential probing to find bounds (`lo`, `hi`).
/// 2. **Bisection**: binary search for exact boundary.
///
/// Returns `(last_index, has_more)`. When `has_more` is `false`, the search is complete.
pub async fn find_last_note_index_paginated<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    cursor: &mut SubchannelCursor,
    budget: &IoBudget,
) -> Result<(Option<u64>, bool), DiscoveryError> {
    // Returns (Some(idx), _) if note exists, (None, false) if empty, (None, true) if out of budget.
    let probe = |idx: u64| {
        let budget = budget.clone();
        async move {
            if !budget.consume(COST_NOTE_PROBING) {
                return Ok((None, true));
            }
            let note_id = compute_note_id(channel_key, token, idx);
            if pool.get_note(note_id).await? != Felt::ZERO {
                Ok((Some(idx), false))
            } else {
                Ok((None, false))
            }
        }
    };

    // Phase 1: Ascending (find bounds)
    if cursor.max_note_index.is_none() {
        let found_sentinel = exponential_ascend(&probe, cursor).await?;
        if !found_sentinel {
            return Ok((cursor.last_note_index, true));
        }
        // Empty subchannel: first probe found sentinel
        if cursor.last_note_index.is_none() {
            return Ok((None, false));
        }
    }

    // Phase 2: Bisection (narrow down to exact boundary)
    let complete = bisect_boundary(&probe, cursor).await?;
    Ok((cursor.last_note_index, !complete))
}

/// Exponential ascending: probes at `lo+step`, `lo+2*step`, `lo+4*step`...
/// until finding an empty slot or exhausting budget.
///
/// Updates cursor in place. Returns `true` if sentinel found, `false` if budget exhausted.
// TODO: Issue probes in batches to amortise RPC round-trip latency.
async fn exponential_ascend<F, Fut>(
    probe: F,
    cursor: &mut SubchannelCursor,
) -> Result<bool, DiscoveryError>
where
    F: Fn(u64) -> Fut,
    Fut: Future<Output = Result<(Option<u64>, bool), DiscoveryError>>,
{
    // Compute step from lo: 2^k where k = trailing_zeros(lo + 1).
    // Reconstructs the exponential sequence: 0, 1, 3, 7, 15, ...
    let mut step = match cursor.last_note_index {
        None | Some(0) => 1,
        Some(n) => 1u64 << (n + 1).trailing_zeros(),
    };
    let mut probe_at = cursor
        .last_note_index
        .map_or(0, |lo| lo.saturating_add(step));

    loop {
        match probe(probe_at).await? {
            (Some(_), _) => {
                cursor.last_note_index = Some(probe_at);
                probe_at = probe_at.saturating_add(step);
                step = step.saturating_mul(2);
            }
            (None, false) => {
                cursor.max_note_index = Some(probe_at);
                return Ok(true);
            }
            (None, true) => return Ok(false),
        }
    }
}

/// Binary search between `lo` (exists) and `hi` (absent) to find
/// the exact last occupied index.
///
/// Updates cursor in place. Returns `true` if complete, `false` if budget exhausted.
async fn bisect_boundary<F, Fut>(
    probe: F,
    cursor: &mut SubchannelCursor,
) -> Result<bool, DiscoveryError>
where
    F: Fn(u64) -> Fut,
    Fut: Future<Output = Result<(Option<u64>, bool), DiscoveryError>>,
{
    let (mut lo, mut hi) = match (cursor.last_note_index, cursor.max_note_index) {
        (Some(lo), Some(hi)) => (lo, hi),
        _ => return Ok(true), // Nothing to bisect
    };

    while lo + 1 < hi {
        let mid = lo + (hi - lo) / 2;
        match probe(mid).await? {
            (Some(_), _) => lo = mid,
            (None, false) => hi = mid,
            (None, true) => {
                cursor.last_note_index = Some(lo);
                cursor.max_note_index = Some(hi);
                return Ok(false);
            }
        }
    }

    cursor.last_note_index = Some(lo);
    cursor.max_note_index = Some(hi);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_backend::MockBackend;
    use crate::test_fixtures::{get_channel_key, get_subchannel_token, load_devnet_fixture};

    /// Helper: create a probe function that returns exists for indices < last_index.
    fn mock_probe(
        last_index: Option<u64>,
    ) -> impl Fn(u64) -> std::future::Ready<Result<(Option<u64>, bool), DiscoveryError>> {
        move |idx| {
            let exists = last_index.is_some_and(|last| idx <= last);
            std::future::ready(Ok(if exists {
                (Some(idx), false)
            } else {
                (None, false)
            }))
        }
    }

    #[tokio::test]
    async fn test_exponential_ascend_empty() {
        let mut cursor = SubchannelCursor::default();
        let found = exponential_ascend(mock_probe(None), &mut cursor)
            .await
            .unwrap();
        assert!(found, "should find sentinel immediately");
        assert_eq!(cursor.last_note_index, None);
        assert_eq!(cursor.max_note_index, Some(0));
    }

    #[tokio::test]
    async fn test_exponential_ascend_one_element() {
        let mut cursor = SubchannelCursor::default();
        let found = exponential_ascend(mock_probe(Some(0)), &mut cursor)
            .await
            .unwrap();
        assert!(found);
        assert_eq!(cursor.last_note_index, Some(0));
        assert_eq!(cursor.max_note_index, Some(1));
    }

    #[tokio::test]
    async fn test_exponential_ascend_multiple_elements() {
        // Elements at 0, 1, 2, 3, 4 (last_index = 4)
        let mut cursor = SubchannelCursor::default();
        let found = exponential_ascend(mock_probe(Some(4)), &mut cursor)
            .await
            .unwrap();
        assert!(found);
        // Probes: 0 (exists), 1 (exists), 3 (exists), 7 (empty)
        assert_eq!(cursor.last_note_index, Some(3));
        assert_eq!(cursor.max_note_index, Some(7));
    }

    #[tokio::test]
    async fn test_bisect_boundary_adjacent() {
        // lo=0, hi=1 → no bisection needed
        let mut cursor = SubchannelCursor {
            last_note_index: Some(0),
            max_note_index: Some(1),
        };
        let complete = bisect_boundary(mock_probe(Some(0)), &mut cursor)
            .await
            .unwrap();
        assert!(complete);
        assert_eq!(cursor.last_note_index, Some(0));
    }

    #[tokio::test]
    async fn test_bisect_boundary_gap() {
        // lo=3, hi=7, actual last is 4
        let mut cursor = SubchannelCursor {
            last_note_index: Some(3),
            max_note_index: Some(7),
        };
        let complete = bisect_boundary(mock_probe(Some(4)), &mut cursor)
            .await
            .unwrap();
        assert!(complete);
        assert_eq!(cursor.last_note_index, Some(4));
        assert_eq!(cursor.max_note_index, Some(5));
    }

    #[tokio::test]
    async fn test_find_last_note_index_with_fixture() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .expect("Alice should have at least one channel");

        let token = get_subchannel_token(&backend, channel_key)
            .await
            .expect("Alice's channel should have at least one subchannel");

        let mut cursor = SubchannelCursor::default();
        let budget = IoBudget::new(100);

        let (last_index, has_more) =
            find_last_note_index_paginated(&backend, channel_key, token, &mut cursor, &budget)
                .await
                .unwrap();

        // Alice has 1 note at index 0
        assert_eq!(last_index, Some(0));
        assert!(!has_more);
    }

    #[tokio::test]
    async fn test_find_last_note_index_empty() {
        let backend = MockBackend::empty();
        let channel_key = Felt::from_hex_unchecked("0x12345");
        let token = Felt::from_hex_unchecked("0x67890");

        let mut cursor = SubchannelCursor::default();
        let budget = IoBudget::new(100);

        let (last_index, has_more) =
            find_last_note_index_paginated(&backend, channel_key, token, &mut cursor, &budget)
                .await
                .unwrap();

        assert_eq!(last_index, None);
        assert!(!has_more);
    }

    #[tokio::test]
    async fn test_find_last_note_index_budget_exhausted_ascending() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .expect("Alice should have at least one channel");

        let token = get_subchannel_token(&backend, channel_key)
            .await
            .expect("Alice's channel should have at least one subchannel");

        let mut cursor = SubchannelCursor::default();

        // Budget for 1 probe: finds note at 0, exhausted before probing 1
        let budget = IoBudget::new(COST_NOTE_PROBING);
        let (last_index, has_more) =
            find_last_note_index_paginated(&backend, channel_key, token, &mut cursor, &budget)
                .await
                .unwrap();

        assert_eq!(last_index, Some(0));
        assert!(has_more, "budget exhausted during ascending");
        assert_eq!(cursor.last_note_index, Some(0));
        assert!(cursor.max_note_index.is_none(), "sentinel not found yet");

        // Resume with more budget
        let budget = IoBudget::new(100);
        let (last_index, has_more) =
            find_last_note_index_paginated(&backend, channel_key, token, &mut cursor, &budget)
                .await
                .unwrap();

        assert_eq!(last_index, Some(0));
        assert!(!has_more);
    }
}
