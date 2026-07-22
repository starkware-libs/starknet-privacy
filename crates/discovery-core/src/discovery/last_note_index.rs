//! Note index boundary finding.
//!
//! Finds the last note index in a subchannel via exponential probe + bisection.
//! No decryption, no nullifier checks — just probes note existence.
//!
//! [`find_last_note_index`] is the unified entry point: runs an atomic probe + bisect
//! cycle, shared by both incoming (notes discovery) and outgoing (last-note-index)
//! flows.

use std::collections::HashMap;

use starknet_core::types::StorageResult;
use starknet_types_core::felt::Felt;

use crate::discovery::cursor::SubchannelCursor;
use crate::discovery::{DiscoveryError, COST_NOTE_PROBING};

use crate::io_budget::IoBudget;
use crate::privacy_pool::hashes::compute_note_id;
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// Maximum budget for a single [`find_boundary`] call.
///
/// `max_note_log_index + 1` probe offsets + up to `max_note_log_index` bisect
/// steps, each costing `COST_NOTE_PROBING`.
pub fn boundary_budget(max_note_log_index: u32) -> usize {
    let max_note_log_index: usize = max_note_log_index
        .try_into()
        .expect("max_note_log_index is a config value that must fit in usize");
    (2 * max_note_log_index + 1) * COST_NOTE_PROBING
}

/// Finds the last note index via atomic exponential probe + bisection.
///
/// When `cursor.total_n_notes` is already cached, returns immediately.
/// Otherwise, budget is allocated atomically: consumes [`boundary_budget`]
/// upfront, then reclaims unused units after completion. Either completes
/// fully or makes no progress (budget too small).
///
/// Returns `(probe_cache, has_more)`:
/// - `probe_cache`: index → (note_id, storage_result) from probe hits (for incoming scan).
///   The `StorageResult` carries both the packed value and the slot's last-update block.
/// - `has_more`: `true` if budget was insufficient and another call is needed.
///
/// On success, sets `cursor.total_n_notes`. Callers read the result via
/// `cursor.last_existing_index()`.
pub async fn find_last_note_index<S: IViews>(
    pool: &S,
    channel_key: &SecretFelt,
    token: Felt,
    cursor: &mut SubchannelCursor,
    max_note_log_index: u32,
    budget: &IoBudget,
) -> Result<(HashMap<u64, (Felt, StorageResult)>, bool), DiscoveryError> {
    if cursor.total_n_notes.is_some() {
        return Ok((HashMap::new(), false));
    }

    let max_budget = boundary_budget(max_note_log_index);
    if !budget.consume(max_budget) {
        return Ok((HashMap::new(), true));
    }

    let start_index = cursor.start_index();
    let max_bisect_steps: usize = max_note_log_index
        .try_into()
        .expect("max_note_log_index is a config value that must fit in usize");
    let mut cache = HashMap::new();

    let Some((lower_bound, upper_bound)) = exponential_probe(
        pool,
        channel_key,
        token,
        start_index,
        max_note_log_index,
        &mut cache,
    )
    .await?
    else {
        // Empty subchannel.
        budget.reclaim(max_bisect_steps * COST_NOTE_PROBING);
        cursor.total_n_notes = Some(0);
        return Ok((cache, false));
    };

    let (boundary, bisect_step_count) = bisect_boundary(
        pool,
        channel_key,
        token,
        lower_bound,
        upper_bound,
        &mut cache,
    )
    .await?;
    budget.reclaim((max_bisect_steps - bisect_step_count) * COST_NOTE_PROBING);
    cursor.total_n_notes = Some(boundary + 1);
    cursor.last_note_index = Some(boundary);
    Ok((cache, false))
}

/// Binary search between `lower_bound` (exists) and `upper_bound` (absent) to
/// find the exact last occupied index. Hits are inserted into `cache`.
///
/// Budget is pre-allocated by the caller. Returns
/// `(last_existing_index, step_count)`.
async fn bisect_boundary<S: IViews>(
    pool: &S,
    channel_key: &SecretFelt,
    token: Felt,
    mut lower_bound: u64,
    mut upper_bound: u64,
    cache: &mut HashMap<u64, (Felt, StorageResult)>,
) -> Result<(u64, usize), DiscoveryError> {
    let mut step_count = 0;
    while lower_bound + 1 < upper_bound {
        let mid = lower_bound + (upper_bound - lower_bound) / 2;
        let note_id = compute_note_id(channel_key, token, mid);
        step_count += 1;
        let result = pool.get_note_with_block(note_id).await?;
        if result.value != Felt::ZERO {
            cache.insert(mid, (note_id, result));
            lower_bound = mid;
        } else {
            upper_bound = mid;
        }
    }
    Ok((lower_bound, step_count))
}

/// Probes note existence at exponentially increasing indices in a single batch.
/// Hits are inserted into the caller-provided `cache`.
///
/// From `start`, probes at offsets `[0, 1, 3, 7, 15, ..., 2^max_note_log_index - 1]`
/// (`max_note_log_index + 1` offsets total). The `2^k - 1` pattern is denser at the
/// start than powers of 2, yielding more cache hits for small subchannels.
///
/// Returns:
/// - `Ok(None)` — empty subchannel (first probe missed); no bisection needed.
/// - `Ok(Some((lower_bound, upper_bound)))` — `lower_bound` is the last index
///   confirmed to exist (bisection lower bound), `upper_bound` is the first
///   index confirmed empty (bisection upper bound).
/// - `Err` — all probes hit, `max_note_log_index` too small.
///
/// Budget is pre-allocated by [`find_last_note_index`] — this function issues
/// the full batch unconditionally.
async fn exponential_probe<S: IViews>(
    pool: &S,
    channel_key: &SecretFelt,
    token: Felt,
    start_index: u64,
    max_note_log_index: u32,
    cache: &mut HashMap<u64, (Felt, StorageResult)>,
) -> Result<Option<(u64, u64)>, DiscoveryError> {
    // Offsets: [0, 1, 3, 7, 15, ..., 2^k - 1] where k = max_note_log_index.
    let offsets: Vec<u64> = (0..=max_note_log_index)
        .map(|k| if k == 0 { 0 } else { (1u64 << k) - 1 })
        .collect();

    let note_ids: Vec<_> = offsets
        .iter()
        .map(|&off| compute_note_id(channel_key, token, start_index + off))
        .collect();
    let results = pool.get_notes_batch_with_block(&note_ids).await?;

    let mut lower_bound: Option<u64> = None;

    for (i, result) in results.into_iter().enumerate() {
        let idx = start_index + offsets[i];
        if result.value != Felt::ZERO {
            cache.insert(idx, (note_ids[i], result));
            lower_bound = Some(idx);
        } else {
            return Ok(lower_bound.map(|lower_bound| (lower_bound, idx)));
        }
    }

    // All probes hit — subchannel has more notes than the probe range
    // covers (>2^max_note_log_index). Config too small.
    Err(DiscoveryError::InvalidCursor(format!(
        "note boundary exceeds max_note_log_index={max_note_log_index} \
         (>{} notes from start_index={start_index})",
        1u64.checked_shl(max_note_log_index).unwrap_or(u64::MAX)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::privacy_pool::hashes::compute_note_id;
    use crate::privacy_pool::storage_slots;
    use crate::storage_backend::MockBackend;
    use crate::test_fixtures::{get_channel_key, get_subchannel_token, load_devnet_fixture};

    const CK_FELT: Felt = Felt::from_hex_unchecked("0x12345");
    const TK: Felt = Felt::from_hex_unchecked("0x67890");
    const DEFAULT_MAX_LOG: u32 = 30;

    fn ck() -> SecretFelt {
        SecretFelt::new(CK_FELT)
    }

    /// Creates a mock backend with notes at indices 0..=last_index.
    fn mock_with_notes(last_index: Option<u64>) -> MockBackend {
        let channel_key = ck();
        let mut backend = MockBackend::empty();
        if let Some(last) = last_index {
            for i in 0..=last {
                let note_id = compute_note_id(&channel_key, TK, i);
                let slot = storage_slots::notes(note_id);
                backend.insert(slot, Felt::ONE); // non-zero = exists
            }
        }
        backend
    }

    #[tokio::test]
    async fn test_exponential_probe_empty() {
        let backend = mock_with_notes(None);
        let channel_key = ck();
        let mut cache = HashMap::new();
        let result = exponential_probe(&backend, &channel_key, TK, 0, DEFAULT_MAX_LOG, &mut cache)
            .await
            .unwrap();

        assert!(result.is_none(), "empty subchannel returns None");
        assert!(cache.is_empty());
    }

    #[tokio::test]
    async fn test_exponential_probe_one_element() {
        // Elements at 0 only. Probes: offset 0→0 (hit), 1→1 (miss).
        let backend = mock_with_notes(Some(0));
        let channel_key = ck();
        let mut cache = HashMap::new();
        let (lower_bound, upper_bound) =
            exponential_probe(&backend, &channel_key, TK, 0, DEFAULT_MAX_LOG, &mut cache)
                .await
                .unwrap()
                .expect("non-empty subchannel");

        assert_eq!(lower_bound, 0);
        assert_eq!(upper_bound, 1);
        assert_eq!(cache.len(), 1);
    }

    #[tokio::test]
    async fn test_exponential_probe_multiple_elements() {
        // Elements at 0..=4. Probes: offset 0→0 (hit), 1→1 (hit),
        // 3→3 (hit), 7→7 (miss). Sentinel found.
        let backend = mock_with_notes(Some(4));
        let channel_key = ck();
        let mut cache = HashMap::new();
        let (lower_bound, upper_bound) =
            exponential_probe(&backend, &channel_key, TK, 0, DEFAULT_MAX_LOG, &mut cache)
                .await
                .unwrap()
                .expect("non-empty subchannel");

        assert_eq!(lower_bound, 3);
        assert_eq!(upper_bound, 7);
        assert_eq!(cache.len(), 3);
    }

    #[tokio::test]
    async fn test_exponential_probe_gap_between_last_hit_and_sentinel() {
        // Notes at 0..=2. Probe offsets [0, 1, 3, ...]:
        //   0→hit, 1→hit, 3→miss (sentinel). Gap at index 2 is unprobed.
        let backend = mock_with_notes(Some(2));
        let channel_key = ck();
        let mut cache = HashMap::new();
        let (lower_bound, upper_bound) =
            exponential_probe(&backend, &channel_key, TK, 0, DEFAULT_MAX_LOG, &mut cache)
                .await
                .unwrap()
                .expect("non-empty subchannel");

        assert_eq!(lower_bound, 1);
        assert_eq!(upper_bound, 3);
        assert_eq!(cache.len(), 2, "probed indices 0 and 1");
    }

    #[tokio::test]
    async fn test_exponential_probe_all_hit_errors() {
        // 10 notes at 0..=9. With max_note_log_index=3, probe offsets are
        // [0, 1, 3, 7] — all hit. Should error.
        let backend = mock_with_notes(Some(9));
        let channel_key = ck();
        let mut cache = HashMap::new();
        let result = exponential_probe(&backend, &channel_key, TK, 0, 3, &mut cache).await;

        assert!(result.is_err(), "all probes hit should error");
        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("max_note_log_index=3"),
            "error should mention the config: {error}"
        );
    }

    #[tokio::test]
    async fn test_find_last_note_index_empty_subchannel() {
        let backend = mock_with_notes(None);
        let budget = IoBudget::new(100);
        let mut cursor = SubchannelCursor::default();
        let channel_key = ck();
        let (cache, has_more) = find_last_note_index(
            &backend,
            &channel_key,
            TK,
            &mut cursor,
            DEFAULT_MAX_LOG,
            &budget,
        )
        .await
        .unwrap();

        assert!(cache.is_empty());
        assert!(!has_more);
        assert_eq!(cursor.total_n_notes, Some(0));
        assert_eq!(cursor.last_existing_index(), None);
        // Probe cost only (31 offsets), bisect budget reclaimed.
        assert_eq!(
            budget.remaining(),
            100 - boundary_budget(DEFAULT_MAX_LOG) + DEFAULT_MAX_LOG as usize
        );
    }

    #[tokio::test]
    async fn test_find_last_note_index_one_note() {
        let backend = mock_with_notes(Some(0));
        let budget = IoBudget::new(100);
        let channel_key = ck();
        let mut cursor = SubchannelCursor::default();
        let (cache, has_more) = find_last_note_index(
            &backend,
            &channel_key,
            TK,
            &mut cursor,
            DEFAULT_MAX_LOG,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(cache.len(), 1);
        assert!(!has_more);
        assert_eq!(cursor.total_n_notes, Some(1));
        assert_eq!(cursor.last_existing_index(), Some(0));
        // Adjacent boundary (lo=0, hi=1) — no bisection, bisect budget reclaimed.
        let num_probe_offsets = DEFAULT_MAX_LOG as usize + 1;
        assert_eq!(budget.remaining(), 100 - num_probe_offsets);
    }

    #[tokio::test]
    async fn test_find_last_note_index_with_gap() {
        // 3 notes at 0..=2. Probe hits 0, 1, misses 3.
        // Bisection: mid=2, hit → lo=2. lo+1==hi(3) → done. 1 bisect step.
        let backend = mock_with_notes(Some(2));
        let budget = IoBudget::new(100);
        let channel_key = ck();
        let mut cursor = SubchannelCursor::default();
        let (cache, has_more) = find_last_note_index(
            &backend,
            &channel_key,
            TK,
            &mut cursor,
            DEFAULT_MAX_LOG,
            &budget,
        )
        .await
        .unwrap();

        assert!(!has_more);
        assert_eq!(cursor.total_n_notes, Some(3));
        assert_eq!(cache.len(), 3, "probe cached 0,1 + bisect cached 2");
        let num_probe_offsets = DEFAULT_MAX_LOG as usize + 1;
        let bisect_steps = 1;
        assert_eq!(
            budget.remaining(),
            100 - num_probe_offsets - bisect_steps,
            "31 probe + 1 bisect step"
        );
    }

    #[tokio::test]
    async fn test_find_last_note_index_five_notes() {
        // 5 notes at 0..=4. Probe hits 0, 1, 3, misses at 7.
        // Bisection: lo=3, hi=7 → mid=5 (miss)→hi=5 → mid=4 (hit)→lo=4.
        // lo+1==hi(5) → done. 2 bisect steps.
        let backend = mock_with_notes(Some(4));
        let budget = IoBudget::new(100);
        let channel_key = ck();
        let mut cursor = SubchannelCursor::default();
        let (_cache, has_more) = find_last_note_index(
            &backend,
            &channel_key,
            TK,
            &mut cursor,
            DEFAULT_MAX_LOG,
            &budget,
        )
        .await
        .unwrap();

        assert!(!has_more);
        assert_eq!(cursor.total_n_notes, Some(5));
        let num_probe_offsets = DEFAULT_MAX_LOG as usize + 1;
        let bisect_steps = 2;
        assert_eq!(budget.remaining(), 100 - num_probe_offsets - bisect_steps);
    }

    #[tokio::test]
    async fn test_find_last_note_index_budget_insufficient() {
        let backend = mock_with_notes(Some(100));
        let channel_key = ck();
        let mut cursor = SubchannelCursor::default();
        // Budget below the minimum for boundary finding.
        let budget = IoBudget::new(boundary_budget(DEFAULT_MAX_LOG) - 1);
        let (cache, has_more) = find_last_note_index(
            &backend,
            &channel_key,
            TK,
            &mut cursor,
            DEFAULT_MAX_LOG,
            &budget,
        )
        .await
        .unwrap();

        assert!(cache.is_empty());
        assert!(has_more, "budget insufficient — no boundary found");
        assert!(cursor.total_n_notes.is_none());
        assert_eq!(
            budget.remaining(),
            boundary_budget(DEFAULT_MAX_LOG) - 1,
            "budget unchanged on insufficient allocation"
        );
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

        let token = get_subchannel_token(&backend, &channel_key)
            .await
            .expect("Alice's channel should have at least one subchannel");

        let mut cursor = SubchannelCursor::default();
        let budget = IoBudget::new(100);

        let (_cache, has_more) =
            find_last_note_index(&backend, &channel_key, token, &mut cursor, 30, &budget)
                .await
                .unwrap();

        // Alice has 1 note at index 0
        assert!(!has_more);
        assert_eq!(cursor.total_n_notes, Some(1));
        assert_eq!(cursor.last_existing_index(), Some(0));
    }

    #[tokio::test]
    async fn test_find_last_note_index_empty_fixture() {
        let backend = MockBackend::empty();
        let channel_key = ck();

        let mut cursor = SubchannelCursor::default();
        let budget = IoBudget::new(100);

        let (_cache, has_more) =
            find_last_note_index(&backend, &channel_key, TK, &mut cursor, 30, &budget)
                .await
                .unwrap();

        assert!(!has_more);
        assert_eq!(cursor.total_n_notes, Some(0));
        assert_eq!(cursor.last_existing_index(), None);
    }

    #[tokio::test]
    async fn test_find_last_note_index_budget_insufficient_then_resume() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .expect("Alice should have at least one channel");

        let token = get_subchannel_token(&backend, &channel_key)
            .await
            .expect("Alice's channel should have at least one subchannel");

        let mut cursor = SubchannelCursor::default();

        // Budget below minimum — can't start boundary finding.
        let budget = IoBudget::new(boundary_budget(30) - 1);
        let (_cache, has_more) =
            find_last_note_index(&backend, &channel_key, token, &mut cursor, 30, &budget)
                .await
                .unwrap();

        assert!(has_more, "budget insufficient");
        assert!(cursor.total_n_notes.is_none(), "boundary not cached yet");

        // Resume with sufficient budget.
        let budget = IoBudget::new(100);
        let (_cache, has_more) =
            find_last_note_index(&backend, &channel_key, token, &mut cursor, 30, &budget)
                .await
                .unwrap();

        assert!(!has_more);
        assert_eq!(cursor.total_n_notes, Some(1));
        assert_eq!(cursor.last_existing_index(), Some(0));
    }

    #[tokio::test]
    async fn test_find_last_note_index_skips_when_cached() {
        let backend = mock_with_notes(Some(4));
        let channel_key = ck();
        let mut cursor = SubchannelCursor::default();

        // First call: finds boundary.
        let budget = IoBudget::new(100);
        let (_cache, has_more) = find_last_note_index(
            &backend,
            &channel_key,
            TK,
            &mut cursor,
            DEFAULT_MAX_LOG,
            &budget,
        )
        .await
        .unwrap();
        assert!(!has_more);
        assert_eq!(cursor.total_n_notes, Some(5));
        let remaining_after_first = budget.remaining();

        // Second call: cached, returns immediately without consuming budget.
        let (cache, has_more) = find_last_note_index(
            &backend,
            &channel_key,
            TK,
            &mut cursor,
            DEFAULT_MAX_LOG,
            &budget,
        )
        .await
        .unwrap();
        assert!(!has_more);
        assert!(cache.is_empty(), "no probe needed — cached");
        assert_eq!(
            budget.remaining(),
            remaining_after_first,
            "no budget consumed"
        );
    }

    /// Regression: cursor.last_note_index must be set after boundary finding.
    #[tokio::test]
    async fn test_find_last_note_index_sets_cursor_last_note_index() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .expect("Alice should have at least one channel");

        let token = get_subchannel_token(&backend, &channel_key)
            .await
            .expect("should have a subchannel");

        let mut cursor = SubchannelCursor::default();
        let budget = IoBudget::new(500);

        let (cache, has_more) =
            find_last_note_index(&backend, &channel_key, token, &mut cursor, 30, &budget)
                .await
                .unwrap();

        assert!(!has_more);
        assert!(!cache.is_empty());
        let boundary = *cache.keys().max().expect("cache non-empty");
        assert_eq!(cursor.last_note_index, Some(boundary));
    }
}
