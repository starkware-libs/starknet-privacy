//! Notes discovery for a subchannel (channel_key + token pair).
//!
//! Two-phase algorithm:
//! 1. **Exponential probe**: batched probes at exponentially increasing indices
//!    to find `max_note_index` (the last index confirmed to exist).
//! 2. **Linear scan**: batch-reads amounts + nullifiers for all notes in
//!    `start..=max_note_index`. No sentinel checking — the contiguous invariant
//!    guarantees all notes in range exist.
//!
//! Parallelization is possible at higher levels:
//! - Multiple subchannel scans (for notes) can run in parallel
//! - Multiple channel scans (for subchannels) can run in parallel

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

use super::cursor::SubchannelCursor;
use super::last_note_index::exponential_ascend;
use super::DiscoveryError;
use super::{COST_NOTE, COST_NOTE_PROBING};
use crate::io_budget::IoBudget;
use crate::privacy_pool::decryption::{decrypt_note_amount, unpack_note_amount};
use crate::privacy_pool::hashes::{compute_note_id, compute_nullifier};
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// A discovered and decrypted note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecryptedNote {
    /// The index of this note within the subchannel.
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
///    batched probes to find the last existing note index.
/// 2. **Linear scan** (when `last_note_index < max_note_index`): batch-reads
///    amounts + nullifiers for notes in range.
///
/// `max_note_index` is kept after scan — used to bound the next exponential
/// probe range. Re-probe triggers when `last_note_index == max_note_index`.
pub async fn discover_notes_paginated<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    cursor: &mut SubchannelCursor,
    decryption_key: &SecretFelt,
    budget: &IoBudget,
) -> Result<(Vec<DecryptedNote>, bool), DiscoveryError> {
    let start_index = cursor.last_note_index.map_or(0, |i| i + 1);

    let need_probe =
        cursor.max_note_index.is_none() || cursor.max_note_index.is_some_and(|m| start_index >= m);

    // Phase 1: Exponential probe
    if need_probe {
        let upper_index_bound = match cursor.max_note_index {
            None => u64::MAX,
            Some(m) => m.saturating_mul(2).max(start_index),
        };
        let result = exponential_ascend(
            pool,
            channel_key,
            token,
            start_index,
            upper_index_bound,
            budget,
        )
        .await?;

        let Some((last_found_index, last_found_packed_amount)) = result.last_found_note else {
            // No notes found at start_index or beyond or out of budget.
            return Ok((Vec::new(), result.budget_exhausted));
        };

        cursor.max_note_index = Some(last_found_index);

        // Single-note case: probe confirmed only start_index exists.
        // Packed amount is already available — only a nullifier check is needed.
        if last_found_index == start_index {
            if !budget.consume(COST_NOTE_PROBING) {
                // Budget exhausted before nullifier check.
                return Ok((Vec::new(), true));
            }
            let note = scan_single_note(
                pool,
                channel_key,
                token,
                start_index,
                last_found_packed_amount,
                decryption_key,
            )
            .await?;
            cursor.last_note_index = Some(start_index);
            // If the note is unspent, return it.
            return Ok((note.into_iter().collect(), false));
        }
    }

    let Some(max_note_index) = cursor.max_note_index else {
        // No max_note_index — nothing to scan.
        return Ok((Vec::new(), false));
    };

    // Phase 2: Linear batch scan
    if start_index > max_note_index {
        // Scan already past max — nothing to do.
        return Ok((Vec::new(), false));
    }

    let result = discover_notes(
        pool,
        channel_key,
        token,
        start_index,
        max_note_index,
        decryption_key,
        budget,
    )
    .await?;

    if let Some(last_index) = result.last_index {
        cursor.last_note_index = Some(last_index);
    }
    Ok((result.notes, result.has_more))
}

/// Linear scan of notes in `start_index..=end_index`.
///
/// Reads amounts + nullifiers in batches. No sentinel checking — the contiguous
/// invariant guarantees all notes in range exist.
// TODO: Consider fetching nullifiers first, then only fetch unspent note amounts
async fn discover_notes<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    start_index: u64,
    end_index: u64,
    decryption_key: &SecretFelt,
    budget: &IoBudget,
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

        let remaining = usize::try_from(end_index - index + 1).unwrap_or(usize::MAX);
        let batch_size = budget.consume_up_to(remaining, COST_NOTE);
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

        let note_ids: Vec<_> = (index..batch_end)
            .map(|i| compute_note_id(channel_key, token, i))
            .collect();
        let batch_nullifiers: Vec<_> = (index..batch_end)
            .map(|i| compute_nullifier(channel_key, token, i, decryption_key))
            .collect();

        let (packed_amounts, nullifier_exists) = pool
            .get_note_and_nullifier_batch(&note_ids, &batch_nullifiers)
            .await?;

        for (j, idx) in (index..batch_end).enumerate() {
            last_scanned_index = Some(idx);

            if !nullifier_exists[j] {
                let (salt, enc_amount) = unpack_note_amount(packed_amounts[j]);
                // TODO: Open notes (salt == 1) store the amount in plaintext,
                // so enc_amount is already the actual amount - no decryption needed.
                let amount = decrypt_note_amount(enc_amount, salt, channel_key, token, idx);
                notes.push(DecryptedNote {
                    index: idx,
                    note_id: note_ids[j],
                    amount,
                    salt,
                });
            }
        }

        index = batch_end;
    }
}

/// Processes a single note whose packed amount is already known from a probe.
///
/// Only needs a nullifier check (cost 1 instead of `COST_NOTE` = 2).
/// Returns `Some(note)` if unspent, `None` if spent.
async fn scan_single_note<S: IViews>(
    pool: &S,
    channel_key: Felt,
    token: Felt,
    note_index: u64,
    packed_amount: Felt,
    decryption_key: &SecretFelt,
) -> Result<Option<DecryptedNote>, DiscoveryError> {
    let nullifier = compute_nullifier(channel_key, token, note_index, decryption_key);
    if pool.nullifier_exists(nullifier).await? {
        return Ok(None);
    }
    let (salt, enc_amount) = unpack_note_amount(packed_amount);
    let amount = decrypt_note_amount(enc_amount, salt, channel_key, token, note_index);
    let note_id = compute_note_id(channel_key, token, note_index);
    Ok(Some(DecryptedNote {
        index: note_index,
        note_id,
        amount,
        salt,
    }))
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
        decryption_key: &SecretFelt,
        budget: &IoBudget,
    ) -> (Vec<DecryptedNote>, bool, SubchannelCursor) {
        let mut cursor = SubchannelCursor::default();
        let (notes, has_more) = discover_notes_paginated(
            backend,
            channel_key,
            token,
            &mut cursor,
            decryption_key,
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
        assert_eq!(notes[0].index, 0);
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
        // With batch_budget=16, the probe batch includes 1 probe (offset 0 = empty).
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
        // The initial probe should not be skipped (no cached probe at index 1).
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
        // Single-note optimization: 1 nullifier check = COST_NOTE_PROBING = 1.
        // Total = 3.
        let budget = IoBudget::new(3).with_batch_budget(2);
        let (notes, has_more) =
            discover_notes_paginated(&backend, channel_key, token, &mut cursor, &key, &budget)
                .await
                .unwrap();

        // Bob's note 0 is spent → filtered out
        assert_eq!(notes.len(), 0, "Bob's note is spent");
        assert!(!has_more, "single-note optimization handled it");
        assert_eq!(cursor.last_note_index, Some(0));
    }
}
