//! Note index boundary probing.
//!
//! Finds the last note index in a subchannel via exponential search + bisection.
//! No decryption, no nullifier checks — just probes note existence.
//!
//! [`exponential_probe`] is shared between notes discovery (finds `max_note_index`
//! for a linear scan) and [`find_last_note_index_paginated`] (outgoing channels).

use std::collections::HashMap;
use std::future::Future;

use starknet_types_core::felt::Felt;

use crate::discovery::cursor::SubchannelCursor;
use crate::discovery::{DiscoveryError, COST_NOTE_PROBING};

use crate::io_budget::IoBudget;
use crate::privacy_pool::hashes::compute_note_id;
use crate::privacy_pool::views::IViews;

/// Default max probe offset for notes discovery. Caps the jump distance to
/// avoid overshooting into sparse index space (offsets: 0, 1, 3, 7, …, 1023).
pub const DEFAULT_MAX_PROBE_OFFSET: u64 = 1024;

/// Result of a batched exponential probe.
pub struct ExponentialProbeResult {
    /// Probed notes that exist: index → (note_id, packed_amount).
    /// Used as a cache during the linear scan to avoid re-fetching amounts.
    pub cache: HashMap<u64, (Felt, Felt)>,
    /// Last index confirmed to exist.
    /// `None` if the first probe missed (empty subchannel) or budget exhausted.
    pub last_found_index: Option<u64>,
    /// First index where no note exists (`None` if all probes hit = need more).
    /// Used by [`find_last_note_index_paginated`] to set the bisection upper bound.
    pub first_empty_index: Option<u64>,
    /// Whether the probe conclusively found the boundary (sentinel or start-of-empty).
    /// `false` when the batch was truncated by budget before reaching a boundary.
    pub probe_complete: bool,
}

/// Finds the last note index via [`exponential_probe`] + [`bisect_boundary`].
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
        let start = cursor.start_index();
        let result = exponential_probe(pool, channel_key, token, start, None, None, budget).await?;

        if let Some(last_found_index) = result.last_found_index {
            cursor.last_note_index = Some(last_found_index);
        }
        if let Some(index) = result.first_empty_index {
            cursor.max_note_index = Some(index);
        }

        // Budget exhausted, all probes hit, or empty subchannel — nothing to bisect yet.
        if cursor.max_note_index.is_none() || cursor.last_note_index.is_none() {
            let has_more = !result.probe_complete;
            return Ok((cursor.last_note_index, has_more));
        }
    }

    // Phase 2: Bisection (narrow down to exact boundary, sequential)
    // Probe returns `(Option<u64>, bool)`:
    //   `Some(idx)` = note exists at idx, `None` = absent.
    //   `bool` = budget exhausted (true = stop early).
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

/// Binary search between `lo` (exists) and `hi` (absent) to find
/// the exact last occupied index.
///
/// Requires both `cursor.last_note_index` (lo) and `cursor.max_note_index` (hi)
/// to be `Some`. The probe closure returns `(Option<u64>, bool)` — see
/// [`find_last_note_index_paginated`] for the contract.
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
        _ => unreachable!("bisect_boundary called without both lo and hi"),
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

/// Probes note existence at exponentially increasing indices in a single batch.
///
/// From `start`, probes at offsets `0, 1, 3, 7, 15, ..., 2^k - 1` capped at
/// `max_probe_offset`. The `2^k - 1` pattern is denser at the start than
/// powers of 2, yielding more cache hits for small subchannels.
///
/// `prior_max_index` narrows the search when a previous probe already found a bound:
/// - `None` (first discovery): offsets up to `max_probe_offset`
/// - `Some(m)` (re-probe after scan): range capped at `m * 2`
///
/// `max_probe_offset` caps the maximum offset per batch. Use
/// `Some(`[`DEFAULT_MAX_PROBE_OFFSET`]`)` for notes discovery or `None` for
/// unbounded probing (e.g. last-note-index search).
///
/// All probed notes that exist are cached in the result for use by the
/// linear scan phase.
///
/// Issues exactly one batch of probes via `pool.get_notes_batch()`. Callers
/// handle iteration via cursor-based pagination.
pub async fn exponential_probe<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    start_index: u64,
    prior_max_index: Option<u64>,
    max_probe_offset: Option<u64>,
    budget: &IoBudget,
) -> Result<ExponentialProbeResult, DiscoveryError> {
    let max_index = match prior_max_index {
        None => start_index.saturating_add(max_probe_offset.unwrap_or(u64::MAX)),
        Some(prior_max) => prior_max.saturating_mul(2).max(start_index),
    };
    let max_probe_offset = max_index.saturating_sub(start_index);

    // Offsets: [0, 1, 3, 7, 15, ..., 2^k - 1] where 2^k - 1 <= max_probe_offset.
    let offsets: Vec<u64> = std::iter::once(0)
        .chain(
            (1..64)
                .map(|exp| (1u64 << exp) - 1)
                .take_while(|&offset| offset <= max_probe_offset),
        )
        .collect();

    // Consume as many probes as budget allows.
    let (batch_size, budget_exhausted) = budget.consume_up_to(offsets.len(), COST_NOTE_PROBING);
    if batch_size == 0 {
        return Ok(ExponentialProbeResult {
            cache: HashMap::new(),
            last_found_index: None,
            first_empty_index: None,
            probe_complete: !budget_exhausted,
        });
    }

    let note_ids: Vec<_> = offsets[..batch_size]
        .iter()
        .map(|&off| compute_note_id(channel_key, token, start_index + off))
        .collect();
    let results = pool.get_notes_batch(&note_ids).await?;

    let mut cache = HashMap::new();
    let mut last_found_index: Option<u64> = None;
    let mut first_empty_index: Option<u64> = None;

    for (i, &packed) in results.iter().enumerate() {
        let idx = start_index + offsets[i];
        if packed != Felt::ZERO {
            cache.insert(idx, (note_ids[i], packed));
            last_found_index = Some(idx);
        } else {
            first_empty_index = Some(idx);
            break;
        }
    }
    // Probe is complete when we found a sentinel, or when no notes exist at all
    // (first probe missed and budget wasn't the limiting factor).
    let probe_complete =
        first_empty_index.is_some() || (!budget_exhausted && last_found_index.is_none());

    Ok(ExponentialProbeResult {
        cache,
        last_found_index,
        first_empty_index,
        probe_complete,
    })
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
    async fn test_exponential_probe_empty() {
        let backend = mock_with_notes(None);
        let budget = IoBudget::new(100);
        let result = exponential_probe(
            &backend,
            CK,
            TK,
            0,
            None,
            Some(DEFAULT_MAX_PROBE_OFFSET),
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.last_found_index, None);
        assert!(result.cache.is_empty());
        assert!(result.probe_complete);
    }

    #[tokio::test]
    async fn test_exponential_probe_one_element() {
        // Elements at 0 only. Probes: offset 0→0 (hit), 1→1 (miss).
        let backend = mock_with_notes(Some(0));
        let budget = IoBudget::new(100);
        let result = exponential_probe(
            &backend,
            CK,
            TK,
            0,
            None,
            Some(DEFAULT_MAX_PROBE_OFFSET),
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.last_found_index, Some(0));
        assert_eq!(result.cache.len(), 1);
        assert!(result.probe_complete);
    }

    #[tokio::test]
    async fn test_exponential_probe_multiple_elements() {
        // Elements at 0..=4. Probes: offset 0→0 (hit), 1→1 (hit),
        // 3→3 (hit), 7→7 (miss)
        let backend = mock_with_notes(Some(4));
        let budget = IoBudget::new(100);
        let result = exponential_probe(
            &backend,
            CK,
            TK,
            0,
            None,
            Some(DEFAULT_MAX_PROBE_OFFSET),
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.last_found_index, Some(3));
        assert_eq!(result.cache.len(), 3);
        assert!(result.probe_complete);
    }

    #[tokio::test]
    async fn test_exponential_ascend_probe_incomplete() {
        let backend = mock_with_notes(Some(100));
        // Budget for only 2 probes: offsets 0, 1
        let budget = IoBudget::new(2 * COST_NOTE_PROBING);
        let result = exponential_probe(
            &backend,
            CK,
            TK,
            0,
            None,
            Some(DEFAULT_MAX_PROBE_OFFSET),
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(result.last_found_index, Some(1));
        assert_eq!(result.cache.len(), 2);
        assert!(!result.probe_complete);
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
            note_discovery_complete: false,
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
            note_discovery_complete: false,
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
        // but no first_empty found — budget_exhausted (all probes hit).
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
