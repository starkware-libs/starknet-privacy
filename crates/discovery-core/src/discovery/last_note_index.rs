//! Note index boundary probing.
//!
//! Probes note existence at exponentially increasing indices — no decryption,
//! no nullifier checks. Used by notes discovery to find `max_note_index`
//! for a linear scan.

use std::collections::HashMap;

use starknet_types_core::felt::Felt;

use crate::discovery::{DiscoveryError, COST_NOTE_PROBING};

use crate::io_budget::IoBudget;
use crate::privacy_pool::hashes::compute_note_id;
use crate::privacy_pool::views::IViews;

/// Maximum offset for exponential probing. Caps the jump distance to avoid
/// overshooting into sparse index space (offsets: 0, 1, 3, 7, …, 1023).
/// TODO: make configurable
const MAX_PROBE_OFFSET: u64 = 1024;

/// Result of a batched exponential probe.
pub struct ExponentialProbeResult {
    /// Probed notes that exist: index → (note_id, packed_amount).
    /// Used as a cache during the linear scan to avoid re-fetching amounts.
    pub cache: HashMap<u64, (Felt, Felt)>,
    /// Last index confirmed to exist.
    /// `None` if the first probe missed (empty subchannel) or budget exhausted.
    pub last_found_index: Option<u64>,
    /// First index where no note exists (`None` if all probes hit = need more).
    pub first_empty_index: Option<u64>,
    /// Whether the probe conclusively found the boundary (sentinel or start-of-empty).
    /// `false` when the batch was truncated by budget before reaching a boundary.
    pub probe_complete: bool,
}

/// Probes note existence at exponentially increasing indices in a single batch.
///
/// From `start`, probes at offsets `0, 1, 3, 7, 15, ..., 2^k - 1` capped at
/// [`MAX_PROBE_OFFSET`]. The `2^k - 1` pattern is denser at the start than
/// powers of 2, yielding more cache hits for small subchannels.
///
/// `prior_max` narrows the search when a previous probe already found a bound:
/// - `None` (first discovery): offsets up to `MAX_PROBE_OFFSET`
/// - `Some(m)` (re-probe after scan): range capped at `m * 2`
///
/// All probed notes that exist are cached in the result for use by the
/// linear scan phase.
///
/// Issues exactly one batch of probes via `pool.get_notes_batch()`. Callers
/// handle iteration via cursor-based pagination.
pub async fn exponential_ascend<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    start_index: u64,
    prior_max_index: Option<u64>,
    budget: &IoBudget,
) -> Result<ExponentialProbeResult, DiscoveryError> {
    let max_index = match prior_max_index {
        None => start_index.saturating_add(MAX_PROBE_OFFSET),
        Some(prior_max) => prior_max.saturating_mul(2).max(start_index),
    };
    let max_probe_offset = max_index.saturating_sub(start_index);

    // Offsets: [0, 1, 3, 7, 15, ..., 2^k - 1] where 2^k - 1 <= min(max_probe_offset, MAX_PROBE_OFFSET).
    let offsets: Vec<u64> = std::iter::once(0)
        .chain(
            (1..64)
                .map(|exp| (1u64 << exp) - 1)
                .take_while(|&offset| offset <= max_probe_offset.min(MAX_PROBE_OFFSET)),
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
        let result = exponential_ascend(&backend, CK, TK, 0, None, &budget)
            .await
            .unwrap();

        assert_eq!(result.last_found_index, None);
        assert!(result.cache.is_empty());
        assert_eq!(result.first_empty_index, Some(0));
        assert!(result.probe_complete);
    }

    #[tokio::test]
    async fn test_exponential_ascend_one_element() {
        // Elements at 0 only. Probes: offset 0→0 (hit), 1→1 (miss).
        let backend = mock_with_notes(Some(0));
        let budget = IoBudget::new(100);
        let result = exponential_ascend(&backend, CK, TK, 0, None, &budget)
            .await
            .unwrap();

        assert_eq!(result.last_found_index, Some(0));
        assert_eq!(result.cache.len(), 1);
        assert_eq!(result.first_empty_index, Some(1));
        assert!(result.probe_complete);
    }

    #[tokio::test]
    async fn test_exponential_ascend_multiple_elements() {
        // Elements at 0..=4. Probes: offset 0→0 (hit), 1→1 (hit),
        // 3→3 (hit), 7→7 (miss)
        let backend = mock_with_notes(Some(4));
        let budget = IoBudget::new(100);
        let result = exponential_ascend(&backend, CK, TK, 0, None, &budget)
            .await
            .unwrap();

        assert_eq!(result.last_found_index, Some(3));
        assert_eq!(result.cache.len(), 3);
        assert_eq!(result.first_empty_index, Some(7));
        assert!(result.probe_complete);
    }

    #[tokio::test]
    async fn test_exponential_ascend_probe_incomplete() {
        let backend = mock_with_notes(Some(100));
        // Budget for only 2 probes: offsets 0, 1
        let budget = IoBudget::new(2 * COST_NOTE_PROBING);
        let result = exponential_ascend(&backend, CK, TK, 0, None, &budget)
            .await
            .unwrap();

        assert_eq!(result.last_found_index, Some(1));
        assert_eq!(result.cache.len(), 2);
        assert_eq!(result.first_empty_index, None);
        assert!(!result.probe_complete);
    }
}
