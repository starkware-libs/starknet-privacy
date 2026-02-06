//! Note index boundary probing.
//!
//! Finds the last note index in a subchannel via exponential search + bisection.
//! No decryption, no nullifier checks — just probes note existence.
//!
//! [`exponential_ascend`] is shared between notes discovery (finds `max_note_index`
//! for a linear scan) and [`find_last_note_index_paginated`] (outgoing channels).

use std::future::Future;

use starknet_types_core::felt::Felt;

use super::cursor::SubchannelCursor;
use super::DiscoveryError;
use super::COST_NOTE_PROBING;
use crate::io_budget::IoBudget;
use crate::privacy_pool::hashes::compute_note_id;
use crate::privacy_pool::views::IViews;

/// Result of a batched exponential probe.
pub struct ExponentialProbeResult {
    /// Last note found to exist: `(index, packed_amount)`.
    /// `None` if the first probe missed (empty subchannel) or budget exhausted.
    pub last_found_note: Option<(u64, Felt)>,
    /// First index where no note exists (`None` if all probes hit = need more).
    /// Used by [`find_last_note_index_paginated`] as bisection upper bound.
    pub first_empty_index: Option<u64>,
    /// Whether the probe ran out of budget before finding a boundary.
    pub budget_exhausted: bool,
}

/// Finds the last note index via [`exponential_ascend`] + [`bisect_boundary`].
///
/// Runs in two phases, resumable via cursor:
/// 1. **Ascending**: batched exponential probing to find bounds (`lo`, `hi`).
/// 2. **Bisection**: sequential binary search for exact boundary.
///
/// Returns `(last_index, has_more)`. When `has_more` is `false`, the search is complete.
pub async fn find_last_note_index_paginated<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    cursor: &mut SubchannelCursor,
    budget: &IoBudget,
) -> Result<(Option<u64>, bool), DiscoveryError> {
    // Phase 1: Ascending (find bounds)
    if cursor.max_note_index.is_none() {
        let start = cursor.last_note_index.map_or(0, |lo| lo + 1);
        let result = exponential_ascend(pool, channel_key, token, start, u64::MAX, budget).await?;

        if let Some((index, _)) = result.last_found_note {
            cursor.last_note_index = Some(index);
        }
        if let Some(index) = result.first_empty_index {
            cursor.max_note_index = Some(index);
        }

        // Budget exhausted or all probes hit — need more probing.
        if cursor.max_note_index.is_none() {
            let has_more = result.budget_exhausted || result.last_found_note.is_some();
            return Ok((cursor.last_note_index, has_more));
        }

        // Empty subchannel: offset-0 probe found sentinel.
        if cursor.last_note_index.is_none() {
            return Ok((None, false));
        }
    }

    // Phase 2: Bisection (narrow down to exact boundary, sequential)
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
    let complete = bisect_boundary(&probe, cursor).await?;
    Ok((cursor.last_note_index, !complete))
}

/// Probes note existence at exponentially increasing indices in a single batch.
///
/// From `start`, probes at offsets `0, 2^0, 2^1, ..., 2^k` where
/// `start + 2^k <= upper_limit`. Offset 0 checks `start` itself — needed
/// when `start` is the only note.
///
/// `upper_limit` caps the search range:
/// - First discovery (no prior knowledge): `u64::MAX`
/// - Re-probe after scan: `max_note_index * 2` (bounded growth)
///
/// Max probes = 1 + floor(log2(upper_limit - start)) + 1.
///
/// Issues exactly one batch of probes via `pool.get_notes_batch()`. Callers
/// handle iteration via cursor-based pagination.
pub async fn exponential_ascend<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    start_index: u64,
    upper_index_bound: u64,
    budget: &IoBudget,
) -> Result<ExponentialProbeResult, DiscoveryError> {
    let range = upper_index_bound.saturating_sub(start_index);

    // Offsets: [0, 1, 2, 4, 8, ..., 2^k] where 2^k <= range.
    let offsets: Vec<u64> = std::iter::once(0)
        .chain(
            (0..64)
                .map(|exp| 1u64 << exp)
                .take_while(|&off| off <= range),
        )
        .collect();

    // Consume as many probes as budget allows (capped by batch_budget internally).
    let batch_size = budget.consume_up_to(offsets.len(), COST_NOTE_PROBING);
    if batch_size == 0 {
        return Ok(ExponentialProbeResult {
            last_found_note: None,
            first_empty_index: None,
            budget_exhausted: true,
        });
    }

    let note_ids: Vec<_> = offsets[..batch_size]
        .iter()
        .map(|&off| compute_note_id(channel_key, token, start_index + off))
        .collect();
    let results = pool.get_notes_batch(&note_ids).await?;

    let mut last_found_note: Option<(u64, Felt)> = None;
    let mut first_empty_index: Option<u64> = None;
    for (i, &packed) in results.iter().enumerate() {
        let idx = start_index + offsets[i];
        if packed != Felt::ZERO {
            last_found_note = Some((idx, packed));
        } else {
            first_empty_index = Some(idx);
            break;
        }
    }

    let budget_exhausted = first_empty_index.is_none() && batch_size < offsets.len();

    Ok(ExponentialProbeResult {
        last_found_note,
        first_empty_index,
        budget_exhausted,
    })
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
    use crate::privacy_pool::hashes::compute_note_id;
    use crate::privacy_pool::storage_slots;
    use crate::storage_backend::MockBackend;
    use crate::test_fixtures::{get_channel_key, get_subchannel_token, load_devnet_fixture};

    const CK: Felt = Felt::from_hex_unchecked("0x12345");
    const TK: Felt = Felt::from_hex_unchecked("0x67890");

    /// Creates a mock backend with notes at indices 0..=last_index.
    fn mock_with_notes(last_index: Option<u64>) -> MockBackend {
        let mut backend = MockBackend::empty();
        if let Some(last) = last_index {
            for i in 0..=last {
                let note_id = compute_note_id(CK, TK, i);
                let slot = storage_slots::notes(note_id);
                backend.insert(slot, Felt::ONE); // non-zero = exists
            }
        }
        backend
    }

    #[tokio::test]
    async fn test_exponential_ascend_empty() {
        let backend = mock_with_notes(None);
        let budget = IoBudget::new(100);
        let result = exponential_ascend(&backend, CK, TK, 0, u64::MAX, &budget)
            .await
            .unwrap();

        assert_eq!(result.last_found_note, None);
        assert_eq!(result.first_empty_index, Some(0));
        assert!(!result.budget_exhausted);
    }

    #[tokio::test]
    async fn test_exponential_ascend_one_element() {
        let backend = mock_with_notes(Some(0));
        let budget = IoBudget::new(100);
        let result = exponential_ascend(&backend, CK, TK, 0, u64::MAX, &budget)
            .await
            .unwrap();

        assert_eq!(result.last_found_note, Some((0, Felt::ONE)));
        assert_eq!(result.first_empty_index, Some(1));
        assert!(!result.budget_exhausted);
    }

    #[tokio::test]
    async fn test_exponential_ascend_multiple_elements() {
        // Elements at 0..=4. Probes: offset 0→0 (hit), 1→1 (hit), 2→2 (hit),
        // 4→4 (hit), 8→8 (miss)
        let backend = mock_with_notes(Some(4));
        let budget = IoBudget::new(100);
        let result = exponential_ascend(&backend, CK, TK, 0, u64::MAX, &budget)
            .await
            .unwrap();

        assert_eq!(result.last_found_note, Some((4, Felt::ONE)));
        assert_eq!(result.first_empty_index, Some(8));
        assert!(!result.budget_exhausted);
    }

    #[tokio::test]
    async fn test_exponential_ascend_budget_exhausted() {
        let backend = mock_with_notes(Some(100));
        // Budget for only 2 probes: offsets 0, 1
        let budget = IoBudget::new(2 * COST_NOTE_PROBING);
        let result = exponential_ascend(&backend, CK, TK, 0, u64::MAX, &budget)
            .await
            .unwrap();

        assert_eq!(result.last_found_note, Some((1, Felt::ONE)));
        assert_eq!(result.first_empty_index, None);
        assert!(result.budget_exhausted);
    }

    /// Helper: mock bisection probe.
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
    async fn test_bisect_boundary_adjacent() {
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

        // Budget for 1 probe: batch gets offset 0 only (note at 0 exists),
        // but no first_empty found — budget_exhausted.
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
