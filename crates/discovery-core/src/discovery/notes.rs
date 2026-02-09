//! Notes discovery for a subchannel (channel_key + token pair).
//!
//! Two-phase algorithm:
//! 1. **Exponential probe**: batched probes at exponentially increasing indices
//!    to find `max_note_index` (the last index confirmed to exist).
//! 2. **Linear scan**: nullifier-first batches for all notes in
//!    `start..=max_note_index`. Spent notes skip the amount fetch; cached
//!    amounts from the probe phase skip it too.
//!
//! Parallelization is possible at higher levels:
//! - Multiple subchannel scans (for notes) can run in parallel
//! - Multiple channel scans (for subchannels) can run in parallel

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

use tracing::{debug, trace};

use super::last_note_index::exponential_ascend;
use super::{DiscoveryError, SubchannelCursor, COST_NOTE};
use crate::discovery::COST_NOTE_PROBING;
use crate::io_budget::IoBudget;
use crate::privacy_pool::decryption::{decrypt_note_amount, unpack_note_amount};
use crate::privacy_pool::felt_hex;
use crate::privacy_pool::hashes::{compute_note_id, compute_nullifier};
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// A discovered and decrypted note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecryptedNote {
    /// The sender's address. Set by the sync orchestrator after discovery.
    #[serde(default)]
    pub sender_addr: Felt,
    /// The token address. Set by the sync orchestrator after discovery.
    #[serde(default)]
    pub token: Felt,
    /// The note's index within its subchannel.
    pub index: u64,
    /// The note ID (storage key).
    pub note_id: Felt,
    /// The decrypted amount.
    pub amount: u128,
    /// The salt used for encryption.
    pub salt: u128,
}

/// Result of notes discovery operation.
#[derive(Debug, Clone)]
pub struct NotesDiscoveryResult {
    /// List of discovered and decrypted notes.
    pub notes: Vec<DecryptedNote>,
    /// Index of the last scanned note, or `None` if no notes were scanned.
    /// Includes spent (filtered) notes. Use for cursor updates:
    /// `cursor.last_note_index = result.last_index`.
    pub last_index: Option<u64>,
    /// Whether there may be more notes to discover.
    /// `true` if stopped due to budget exhaustion, `false` if all notes scanned.
    pub has_more: bool,
}

/// Discovers notes with cursor-based pagination using batched RPC calls.
///
/// Two-phase algorithm:
/// 1. **Exponential probe** (when `max_note_index` is unknown or scan caught up):
///    batched probes to find the last existing note index. All probe hits are
///    cached for use by the linear scan.
/// 2. **Linear scan** (when `last_note_index < max_note_index`): nullifier-first
///    batches that skip amount fetches for spent and cached notes.
///
/// `max_note_index` is kept after scan — used to bound the next exponential
/// probe range. Re-probe triggers when `last_note_index == max_note_index`.
pub async fn discover_notes_paginated<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    cursor: &mut SubchannelCursor,
    private_key: &SecretFelt,
    budget: &IoBudget,
) -> Result<(Vec<DecryptedNote>, bool), DiscoveryError> {
    let start_index = cursor.last_note_index.map_or(0, |i| i + 1);

    debug!(
        token = felt_hex(&token),
        start_index,
        max_note_index = ?cursor.max_note_index,
        budget = budget.remaining(),
        "discover_notes_paginated start"
    );

    let need_probe =
        cursor.max_note_index.is_none() || cursor.max_note_index.is_some_and(|m| start_index >= m);

    // Tracks whether the probe found a sentinel (empty index). When `false`,
    // the subchannel must not be pruned even if the scan reaches max_note_index
    // — there may be notes beyond the capped probe range.
    let mut probe_found_sentinel = !need_probe;

    // Probe cache: index → (note_id, packed_amount) for all probe hits.
    let mut probe_cache = HashMap::new();

    // Phase 1: Exponential probe
    if need_probe {
        let result = exponential_ascend(
            pool,
            channel_key,
            token,
            start_index,
            cursor.max_note_index,
            budget,
        )
        .await?;

        probe_found_sentinel = result.first_empty_index.is_some();

        let Some(last_found_index) = result.last_found_index else {
            // No notes found at start_index or beyond or out of budget.
            return Ok((Vec::new(), result.budget_exhausted));
        };

        cursor.max_note_index = Some(last_found_index);
        probe_cache = result.cache;
    }

    let Some(max_note_index) = cursor.max_note_index else {
        return Ok((Vec::new(), false));
    };

    // Phase 2: Linear batch scan
    if start_index > max_note_index {
        return Ok((Vec::new(), !probe_found_sentinel));
    }

    // TODO: consider doing multiple batches concurrently, if budget allows.
    let result = discover_notes(
        pool,
        channel_key,
        token,
        start_index,
        max_note_index,
        private_key,
        budget,
        &probe_cache,
    )
    .await?;

    if let Some(last_index) = result.last_index {
        cursor.last_note_index = Some(last_index);
    }
    let has_more = result.has_more || !probe_found_sentinel;

    debug!(
        unspent = result.notes.len(),
        last_scanned = ?result.last_index,
        has_more,
        budget = budget.remaining(),
        "discover_notes_paginated done"
    );

    Ok((result.notes, has_more))
}

/// Linear scan of notes in `start_index..=end_index`, batched by budget.
#[allow(clippy::too_many_arguments)]
async fn discover_notes<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    start_index: u64,
    end_index: u64,
    private_key: &SecretFelt,
    budget: &IoBudget,
    probe_cache: &HashMap<u64, (Felt, Felt)>,
) -> Result<NotesDiscoveryResult, DiscoveryError> {
    let mut index = start_index;
    let mut notes = Vec::new();
    let mut last_scanned_index: Option<u64> = None;

    loop {
        if index > end_index {
            return Ok(NotesDiscoveryResult {
                notes,
                last_index: last_scanned_index,
                has_more: false,
            });
        }

        let remaining_notes = usize::try_from(end_index - index + 1)
            .map_err(|_| DiscoveryError::InvalidCursor("note range too large".into()))?;
        let batch_size = budget.consume_up_to(remaining_notes, COST_NOTE);
        if batch_size == 0 {
            return Ok(NotesDiscoveryResult {
                notes,
                last_index: last_scanned_index,
                has_more: true,
            });
        }

        let batch_end = index
            + u64::try_from(batch_size)
                .map_err(|_| DiscoveryError::InvalidCursor("batch size overflow".into()))?;

        let (batch_notes, num_skipped) = process_note_batch(
            pool,
            channel_key,
            token,
            index..batch_end,
            private_key,
            probe_cache,
        )
        .await?;
        notes.extend(batch_notes);

        // Reclaim the budget for the skipped notes.
        budget.reclaim(num_skipped * COST_NOTE_PROBING);

        last_scanned_index = Some(batch_end - 1);
        index = batch_end;
    }
}

/// Processes a single batch of notes: nullifier check → resolve amounts → decrypt.
///
/// Budget for the batch was pre-consumed pessimistically at `COST_NOTE` (2) per
/// note. Returns unspent notes and the number of notes that were skipped due to being spent or
/// having a cached amount from the probe.
async fn process_note_batch<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    indices: std::ops::Range<u64>,
    private_key: &SecretFelt,
    probe_cache: &HashMap<u64, (Felt, Felt)>,
) -> Result<(Vec<DecryptedNote>, usize), DiscoveryError> {
    // Batch-check nullifiers.
    let nullifiers: Vec<_> = indices
        .clone()
        .map(|i| compute_nullifier(channel_key, token, i, private_key))
        .collect();
    let spent_flags = pool.nullifier_exists_batch(&nullifiers).await?;

    // Classify: spent → skip, unspent+cached → insert with amount,
    // unspent+uncached → collect for batch fetch.
    let mut unspent_notes: HashMap<u64, (Felt, Felt)> = HashMap::new();
    let mut indices_to_fetch: Vec<u64> = Vec::new();
    let mut num_skipped = 0;

    for (j, idx) in indices.clone().enumerate() {
        if spent_flags[j] {
            num_skipped += 1;
            continue;
        }
        if let Some(&cached_note) = probe_cache.get(&idx) {
            num_skipped += 1;
            unspent_notes.insert(idx, cached_note);
        } else {
            indices_to_fetch.push(idx);
        }
    }

    // Fetch amounts for uncached unspent notes, merge into map.
    if !indices_to_fetch.is_empty() {
        let note_ids: Vec<_> = indices_to_fetch
            .iter()
            .map(|&index| compute_note_id(channel_key, token, index))
            .collect();
        let packed_values = pool.get_notes_batch(&note_ids).await?;
        for (index, (note_id, packed)) in indices_to_fetch
            .iter()
            .zip(note_ids.into_iter().zip(packed_values))
        {
            unspent_notes.insert(*index, (note_id, packed));
        }
    }

    // Decrypt in index order by iterating the original batch range.
    let notes = indices
        .filter_map(|idx| {
            unspent_notes
                .remove(&idx)
                .map(|(note_id, packed)| decrypt_note(channel_key, token, idx, note_id, packed))
        })
        .collect();

    Ok((notes, num_skipped))
}

/// Unpacks and decrypts a single note from its packed storage value.
fn decrypt_note(
    channel_key: Felt,
    token: Felt,
    index: u64,
    note_id: Felt,
    packed: Felt,
) -> DecryptedNote {
    let (salt, enc_amount) = unpack_note_amount(packed);
    let amount = decrypt_note_amount(enc_amount, salt, channel_key, token, index);
    trace!(index, amount, "unspent note found");
    DecryptedNote {
        sender_addr: Felt::ZERO,
        token: Felt::ZERO,
        index,
        note_id,
        amount,
        salt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage_backend::MockBackend;
    use crate::test_fixtures::{get_channel_key, get_subchannel_token, load_devnet_fixture};

    /// Helper: runs discover_notes_paginated with a fresh default cursor and
    /// returns the result along with the cursor for inspection.
    async fn discover_with_fresh_cursor(
        backend: &MockBackend,
        channel_key: Felt,
        token: Felt,
        private_key: &SecretFelt,
        budget: &IoBudget,
    ) -> (Vec<DecryptedNote>, bool, SubchannelCursor) {
        let mut cursor = SubchannelCursor::default();
        let (notes, has_more) = discover_notes_paginated(
            backend,
            channel_key,
            token,
            &mut cursor,
            private_key,
            budget,
        )
        .await
        .unwrap();
        (notes, has_more, cursor)
    }

    #[tokio::test]
    async fn test_discover_no_notes() {
        let backend = MockBackend::empty();
        let channel_key = Felt::from_hex_unchecked("0x12345");
        let token = Felt::from_hex_unchecked("0x67890");
        let budget = IoBudget::new(100);

        let zero_key = SecretFelt::new(Felt::ZERO);
        let (notes, has_more, _cursor) =
            discover_with_fresh_cursor(&backend, channel_key, token, &zero_key, &budget).await;

        assert_eq!(notes.len(), 0);
        assert!(!has_more);
    }

    #[tokio::test]
    async fn test_discover_notes_alice_self_channel() {
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

        let budget = IoBudget::new(100);
        let key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let (notes, has_more, cursor) =
            discover_with_fresh_cursor(&backend, channel_key, token, &key, &budget).await;

        // Alice deposited 100 STRK, transferred 50 to Bob.
        // The transfer consumed the deposit and wrote a change note (50 STRK)
        // at index 0. This note is unspent.
        assert_eq!(notes.len(), 1, "1 unspent change note");
        assert!(notes[0].amount > 0, "Note amount should be positive");
        assert_eq!(cursor.last_note_index, Some(0));
        assert!(!has_more);
    }

    #[tokio::test]
    async fn test_discover_notes_bob_incoming() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
        )
        .await
        .expect("Bob should have at least one channel");

        let token = get_subchannel_token(&backend, channel_key)
            .await
            .expect("Bob's channel should have at least one subchannel");

        let budget = IoBudget::new(100);
        let key = SecretFelt::new(fixture.constants.bob_viewing_key);
        let (notes, has_more, cursor) =
            discover_with_fresh_cursor(&backend, channel_key, token, &key, &budget).await;

        // Bob withdrew his 50 STRK note → nullifier exists → filtered out
        assert_eq!(notes.len(), 0, "Bob's note is spent");
        assert_eq!(cursor.last_note_index, Some(0), "note 0 was scanned");
        assert!(!has_more);
    }

    #[tokio::test]
    async fn test_discover_notes_incremental() {
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

        // First discovery — Alice has 1 unspent change note (50 STRK at index 0)
        let budget = IoBudget::new(100);
        let key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let mut cursor = SubchannelCursor::default();
        let (notes, has_more) =
            discover_notes_paginated(&backend, channel_key, token, &mut cursor, &key, &budget)
                .await
                .unwrap();
        assert_eq!(notes.len(), 1, "1 unspent change note");
        assert!(!has_more);

        // Incremental discovery — should find 0 new notes (sentinel at index 1)
        let (notes2, has_more2) =
            discover_notes_paginated(&backend, channel_key, token, &mut cursor, &key, &budget)
                .await
                .unwrap();
        assert_eq!(notes2.len(), 0);
        assert!(!has_more2);
    }

    #[tokio::test]
    async fn test_discover_notes_out_of_budget() {
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

        // Budget exhausted before starting
        let budget = IoBudget::new(0);
        let key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let (notes, has_more, _cursor) =
            discover_with_fresh_cursor(&backend, channel_key, token, &key, &budget).await;

        assert_eq!(notes.len(), 0);
        assert!(has_more);
    }

    #[tokio::test]
    async fn test_exponential_probe_empty_subchannel() {
        // Empty subchannel: exponential probe finds sentinel at offset 0.
        // With batch_budget=1, the probe batch includes 1 probe (offset 0 = empty).
        // Cost = 1 (single probe).
        let backend = MockBackend::empty();
        let channel_key = Felt::from_hex_unchecked("0x12345");
        let token = Felt::from_hex_unchecked("0x67890");
        let budget = IoBudget::new(100).with_batch_budget(1);

        let zero_key = SecretFelt::new(Felt::ZERO);
        let (notes, has_more, _cursor) =
            discover_with_fresh_cursor(&backend, channel_key, token, &zero_key, &budget).await;

        assert_eq!(notes.len(), 0);
        assert!(!has_more, "sentinel found, not budget exhaustion");
        assert_eq!(budget.remaining(), 99);
    }

    #[tokio::test]
    async fn test_paginated_full_discovery() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
        )
        .await
        .unwrap();
        let token = get_subchannel_token(&backend, channel_key).await.unwrap();

        let mut cursor = SubchannelCursor::default();
        let budget = IoBudget::new(100);
        let key = SecretFelt::new(fixture.constants.bob_viewing_key);
        let (notes, has_more) =
            discover_notes_paginated(&backend, channel_key, token, &mut cursor, &key, &budget)
                .await
                .unwrap();

        // Bob's note is spent → filtered out
        assert_eq!(notes.len(), 0, "Bob's note is spent");
        assert!(!has_more, "sentinel should be found");
    }

    #[tokio::test]
    async fn test_budget_exhaustion_then_resume_skips_initial_probe() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .unwrap();
        let token = get_subchannel_token(&backend, channel_key).await.unwrap();

        let key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let mut cursor = SubchannelCursor::default();

        // First call with enough budget to discover notes.
        let budget = IoBudget::new(100);
        let (notes, has_more) =
            discover_notes_paginated(&backend, channel_key, token, &mut cursor, &key, &budget)
                .await
                .unwrap();
        assert_eq!(notes.len(), 1);
        assert!(!has_more);

        // Now resume — cursor.last_note_index is Some(0), so start_index = 1.
        // It should find sentinel at index 1 and return immediately.
        let budget2 = IoBudget::new(100);
        let (notes2, has_more2) =
            discover_notes_paginated(&backend, channel_key, token, &mut cursor, &key, &budget2)
                .await
                .unwrap();
        assert_eq!(notes2.len(), 0);
        assert!(!has_more2);
    }

    #[tokio::test]
    async fn test_paginated_budget_limited() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
        )
        .await
        .unwrap();
        let token = get_subchannel_token(&backend, channel_key).await.unwrap();

        let mut cursor = SubchannelCursor::default();
        let key = SecretFelt::new(fixture.constants.bob_viewing_key);
        // Bob has 1 note at index 0. With batch_budget=2:
        // Exponential probe: 2 probes (offsets 0, 1) → hit at 0, miss at 1.
        //   Cost = 2 * COST_NOTE_PROBING = 2.
        // Scan: 1 note at index 0. Pre-consume COST_NOTE=2, nullifier check → spent.
        //   Reclaim 1 (no amount fetch needed). Net cost = 1.
        // Total = 3.
        let budget = IoBudget::new(4).with_batch_budget(2);
        let (notes, has_more) =
            discover_notes_paginated(&backend, channel_key, token, &mut cursor, &key, &budget)
                .await
                .unwrap();

        // Bob's note 0 is spent → filtered out
        assert_eq!(notes.len(), 0, "Bob's note is spent");
        assert!(!has_more, "all notes scanned");
        assert_eq!(cursor.last_note_index, Some(0));
    }

    #[tokio::test]
    async fn test_probe_cache_saves_budget() {
        // Alice has 1 unspent note at index 0. The probe hits index 0 and
        // caches its packed_amount. The scan only needs a nullifier check —
        // amount comes from cache, saving 1 budget unit.
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .unwrap();
        let token = get_subchannel_token(&backend, channel_key).await.unwrap();

        let key = SecretFelt::new(fixture.constants.alice_viewing_key);
        let budget = IoBudget::new(100);

        let (notes, has_more, cursor) =
            discover_with_fresh_cursor(&backend, channel_key, token, &key, &budget).await;

        assert_eq!(notes.len(), 1, "1 unspent note");
        assert!(!has_more);
        assert_eq!(cursor.last_note_index, Some(0));
        // Probe: 11 probes (offsets 0, 1, 3, 7, ..., 1023) = 11 budget.
        //   Hit at 0, miss at 1 → cache has index 0.
        // Scan: pre-consume 2 (COST_NOTE), nullifier → unspent, cached → reclaim 1.
        //   Net scan cost = 1. Total = 12.
        // Without cache, scan would cost 2 (nullifier + amount fetch). Saves 1.
        assert_eq!(
            budget.remaining(),
            88,
            "cache saves 1 budget unit vs no-cache"
        );
    }
}
