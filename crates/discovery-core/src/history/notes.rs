//! Backward history sync: storage-based note reading.
//!
//! Reads note values via `get_notes_batch_with_block` (batched storage reads)
//! instead of scanning `NoteCreated` events. Each note's `last_update_block`
//! tells us which block it was created in.

use std::collections::HashMap;

use tracing::trace;

use super::types::{HistoryCursor, HistoryNote, HistorySubchannel};
use crate::discovery::{DiscoveryError, COST_NOTE};
use crate::io_budget::IoBudget;
use crate::privacy_pool::decryption::decrypt_packed_value;
use crate::privacy_pool::hashes::compute_note_id;
use crate::privacy_pool::views::IViews;

/// Buffered note scanner that yields one block of notes at a time.
///
/// Holds the intermediate buffer of fetched-but-not-yet-drained notes.
/// Each call to [`BufferedNoteScanner::next_block`] fills empty slots, then drains
/// all notes at the highest block.
pub struct BufferedNoteScanner {
    buffered_notes: HashMap<usize, (u64, HistoryNote)>,
}

impl Default for BufferedNoteScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl BufferedNoteScanner {
    pub fn new() -> Self {
        Self {
            buffered_notes: HashMap::new(),
        }
    }

    /// Drains the next (highest) block of notes.
    ///
    /// 1. Fill empty buffer slots via `get_notes_batch_with_block`.
    /// 2. Find the highest block among buffered notes.
    /// 3. Drain all notes at that block, decrement their subchannel indices.
    ///
    /// Returns:
    /// - `Ok(Some((block_number, notes)))` — got a block of notes
    /// - `Ok(None)` — all subchannels exhausted
    /// - `Err(InsufficientBudget)` — budget ran out
    pub async fn next_block<V: IViews>(
        &mut self,
        views: &V,
        cursor: &mut HistoryCursor,
        budget: &IoBudget,
    ) -> Result<Option<(u64, Vec<HistoryNote>)>, DiscoveryError> {
        // Fill-then-drain loop. A single subchannel can have multiple
        // consecutive notes in the same block; after draining the first and
        // decrementing `next_index`, the refill may surface another note at
        // the same block. Looping until no buffered note matches ensures
        // the block is yielded exactly once.
        let mut block_notes: Vec<HistoryNote> = Vec::new();
        let mut block_number: Option<u64> = None;
        loop {
            self.fill_buffers(views, &cursor.subchannels, budget)
                .await?;

            let target_block = match block_number {
                Some(b) => b,
                None => match self.buffered_notes.values().map(|(b, _)| *b).max() {
                    Some(b) => {
                        block_number = Some(b);
                        b
                    }
                    None => break,
                },
            };

            if !self
                .buffered_notes
                .values()
                .any(|(block, _)| *block == target_block)
            {
                break;
            }

            for (subchannel_index, (_, note)) in self
                .buffered_notes
                .extract_if(|_, (block, _)| *block == target_block)
            {
                block_notes.push(note);
                let subchannel = &mut cursor.subchannels[subchannel_index];
                subchannel.next_index = subchannel.next_index.and_then(|i| i.checked_sub(1));
            }
        }

        trace!(
            block_number,
            drained_notes = block_notes.len(),
            remaining_buffered = self.buffered_notes.len(),
            note_ids = ?block_notes.iter().map(|n| format!("{:#x}", n.note_id)).collect::<Vec<_>>(),
            "next_block: drained"
        );

        Ok(block_number.map(|block| (block, block_notes)))
    }

    /// Fills empty buffer slots by reading note storage for all active subchannels,
    /// then enriching each with channel context and decrypted amount.
    ///
    /// Active subchannels are those that have no buffered result yet and haven't been
    /// exhausted (`next_index` is `Some`).
    ///
    /// Returns `Ok(())` on success (including when no active subchannels).
    /// Returns `Err(InsufficientBudget)` if budget is insufficient.
    async fn fill_buffers<V: IViews>(
        &mut self,
        views: &V,
        subchannels: &[HistorySubchannel],
        budget: &IoBudget,
    ) -> Result<(), DiscoveryError> {
        let active_subchannels: Vec<_> = subchannels
            .iter()
            .enumerate()
            .filter(|(subchannel_index, _)| !self.buffered_notes.contains_key(subchannel_index))
            .filter_map(|(subchannel_index, subchannel)| {
                let next_note_index = subchannel.next_index?;
                let next_note_id =
                    compute_note_id(&subchannel.channel_key, subchannel.token, next_note_index);
                Some((subchannel_index, next_note_id, next_note_index))
            })
            .collect();

        let cost = active_subchannels.len() * COST_NOTE;
        trace!(
            num_active = active_subchannels.len(),
            num_buffered = self.buffered_notes.len(),
            cost,
            budget_remaining = budget.remaining(),
            "fill_buffers: preparing batch read"
        );

        if !active_subchannels.is_empty() {
            budget.try_consume(cost)?;
        }

        let note_ids: Vec<_> = active_subchannels
            .iter()
            .map(|&(_, next_note_id, _)| next_note_id)
            .collect();

        let storage_results = views.get_notes_batch_with_block(&note_ids).await?;

        for (&(subchannel_index, note_id, next_note_index), result) in
            active_subchannels.iter().zip(storage_results)
        {
            let subchannel = &subchannels[subchannel_index];
            let (amount, salt) = decrypt_packed_value(
                result.value,
                &subchannel.channel_key,
                subchannel.token,
                next_note_index,
            );
            let note = HistoryNote {
                channel_kind: subchannel.channel_kind,
                token: subchannel.token,
                note_index: next_note_index,
                note_id,
                counterparty: subchannel.counterparty,
                amount,
                salt,
            };
            self.buffered_notes
                .insert(subchannel_index, (result.last_update_block, note));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use starknet_types_core::felt::Felt;

    use super::*;
    use crate::discovery::DiscoveryError;
    use crate::history::types::{ChannelKind, HistoryCursor, HistorySubchannel};
    use crate::privacy_pool::decryption::OPEN_NOTE_SALT;
    use crate::privacy_pool::hashes::compute_note_id;
    use crate::privacy_pool::storage_slots;
    use crate::privacy_pool::types::SecretFelt;
    use crate::storage_backend::MockBackend;

    fn test_channel_key() -> SecretFelt {
        SecretFelt::new(Felt::from_hex_unchecked("0xCAFE"))
    }

    fn test_token() -> Felt {
        Felt::from_hex_unchecked("0x12345")
    }

    fn test_counterparty() -> Felt {
        Felt::from_hex_unchecked("0xBEEF")
    }

    fn test_subchannel(
        channel_key: SecretFelt,
        token: Felt,
        next_index: Option<u64>,
    ) -> HistorySubchannel {
        HistorySubchannel {
            channel_key,
            token,
            channel_kind: ChannelKind::Incoming,
            counterparty: test_counterparty(),
            next_index,
        }
    }

    fn test_cursor(subchannels: Vec<HistorySubchannel>) -> HistoryCursor {
        HistoryCursor {
            subchannels,
            begin_block_number: Some(u64::MAX),
            history_complete: false,
        }
    }

    fn non_zero_packed() -> Felt {
        Felt::from(0xDEADu64)
    }

    fn insert_note(
        backend: &mut MockBackend,
        channel_key: &SecretFelt,
        token: Felt,
        note_index: u64,
        packed_value: Felt,
        block_number: u64,
    ) {
        let note_id = compute_note_id(channel_key, token, note_index);
        let slot = storage_slots::notes(note_id);
        backend.insert_with_block(slot, packed_value, block_number);
    }

    #[tokio::test]
    async fn next_block_empty_subchannels() {
        let backend = MockBackend::empty();
        let mut cursor = test_cursor(vec![]);
        let mut scanner = BufferedNoteScanner::new();
        let budget = IoBudget::new(100);

        let result = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap();

        assert!(result.is_none());
    }

    #[tokio::test]
    async fn next_block_single_note() {
        let channel_key = test_channel_key();
        let token = test_token();
        let packed_value = non_zero_packed();

        let mut backend = MockBackend::empty();
        insert_note(&mut backend, &channel_key, token, 0, packed_value, 10);

        let mut cursor = test_cursor(vec![test_subchannel(channel_key.clone(), token, Some(0))]);
        let mut scanner = BufferedNoteScanner::new();
        let budget = IoBudget::new(100);

        let (block_number, notes) = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(block_number, 10);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].note_index, 0);
        assert_eq!(notes[0].channel_kind, ChannelKind::Incoming);
        assert_eq!(notes[0].token, token);
        assert_eq!(notes[0].counterparty, test_counterparty());
        assert_eq!(
            notes[0].note_id,
            compute_note_id(&test_channel_key(), token, 0)
        );
        assert!(cursor.subchannels[0].next_index.is_none());
    }

    #[tokio::test]
    async fn next_block_returns_highest_block_first() {
        let channel_key_a = SecretFelt::new(Felt::from_hex_unchecked("0xA1"));
        let channel_key_b = SecretFelt::new(Felt::from_hex_unchecked("0xB2"));
        let token = test_token();
        let packed_value = non_zero_packed();

        let mut backend = MockBackend::empty();
        insert_note(&mut backend, &channel_key_a, token, 0, packed_value, 100);
        insert_note(&mut backend, &channel_key_b, token, 0, packed_value, 80);

        let mut cursor = test_cursor(vec![
            test_subchannel(channel_key_a, token, Some(0)),
            test_subchannel(channel_key_b, token, Some(0)),
        ]);
        let mut scanner = BufferedNoteScanner::new();
        let budget = IoBudget::new(100);

        // First drain: highest block (100)
        let (block_number, notes) = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(block_number, 100);
        assert_eq!(notes.len(), 1);

        // Second drain: block 80
        let (block_number, notes) = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(block_number, 80);
        assert_eq!(notes.len(), 1);
    }

    #[tokio::test]
    async fn next_block_sequential_indices() {
        let channel_key = test_channel_key();
        let token = test_token();
        let packed_value = non_zero_packed();

        let mut backend = MockBackend::empty();
        insert_note(&mut backend, &channel_key, token, 0, packed_value, 10);
        insert_note(&mut backend, &channel_key, token, 1, packed_value, 20);

        let mut cursor = test_cursor(vec![test_subchannel(channel_key.clone(), token, Some(1))]);
        let mut scanner = BufferedNoteScanner::new();
        let budget = IoBudget::new(100);

        // First: block 20, note index 1
        let (block_number, notes) = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(block_number, 20);
        assert_eq!(notes[0].note_index, 1);
        assert_eq!(cursor.subchannels[0].next_index, Some(0));

        // Second: block 10, note index 0
        let (block_number, notes) = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(block_number, 10);
        assert_eq!(notes[0].note_index, 0);
        assert_eq!(cursor.subchannels[0].next_index, None);

        // Third: exhausted — returns None
        let result = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn next_block_zero_budget_returns_error() {
        let channel_key = test_channel_key();
        let token = test_token();
        let packed_value = non_zero_packed();

        let mut backend = MockBackend::empty();
        insert_note(&mut backend, &channel_key, token, 0, packed_value, 10);

        let mut cursor = test_cursor(vec![test_subchannel(channel_key.clone(), token, Some(0))]);
        let mut scanner = BufferedNoteScanner::new();
        let budget = IoBudget::new(0);

        let error = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap_err();

        assert!(
            matches!(error, DiscoveryError::InsufficientBudget { .. }),
            "expected InsufficientBudget, got: {error:?}"
        );
    }

    #[tokio::test]
    async fn next_block_open_note_returns_plaintext_amount() {
        let channel_key = test_channel_key();
        let token = test_token();

        let amount: u128 = 42;
        let packed = Felt::from(OPEN_NOTE_SALT) * Felt::from(1u128 << 64) * Felt::from(1u128 << 64)
            + Felt::from(amount);

        let mut backend = MockBackend::empty();
        insert_note(&mut backend, &channel_key, token, 0, packed, 10);

        let mut cursor = test_cursor(vec![test_subchannel(channel_key.clone(), token, Some(0))]);
        let mut scanner = BufferedNoteScanner::new();
        let budget = IoBudget::new(100);

        let (_, notes) = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(notes[0].amount, 42);
        assert_eq!(notes[0].salt, OPEN_NOTE_SALT);
    }

    #[tokio::test]
    async fn next_block_completes_block_single_subchannel() {
        let channel_key = test_channel_key();
        let token = test_token();
        let packed_value = non_zero_packed();

        // Two consecutive notes in the same block within one subchannel.
        let mut backend = MockBackend::empty();
        insert_note(&mut backend, &channel_key, token, 0, packed_value, 10);
        insert_note(&mut backend, &channel_key, token, 1, packed_value, 10);

        let mut cursor = test_cursor(vec![test_subchannel(channel_key.clone(), token, Some(1))]);
        let mut scanner = BufferedNoteScanner::new();
        let budget = IoBudget::new(100);

        // Should yield both notes in a single call.
        let (block_number, notes) = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(block_number, 10);
        assert_eq!(notes.len(), 2);

        let mut indices: Vec<u64> = notes.iter().map(|n| n.note_index).collect();
        indices.sort();
        assert_eq!(indices, vec![0, 1]);

        // No more notes — exhausted.
        let result = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn next_block_completes_block_across_subchannels() {
        let channel_key_a = SecretFelt::new(Felt::from_hex_unchecked("0xA1"));
        let channel_key_b = SecretFelt::new(Felt::from_hex_unchecked("0xB2"));
        let token = test_token();
        let packed_value = non_zero_packed();

        let mut backend = MockBackend::empty();
        // Subchannel A: two notes in block 10.
        insert_note(&mut backend, &channel_key_a, token, 0, packed_value, 10);
        insert_note(&mut backend, &channel_key_a, token, 1, packed_value, 10);
        // Subchannel B: one note in block 5.
        insert_note(&mut backend, &channel_key_b, token, 0, packed_value, 5);

        let mut cursor = test_cursor(vec![
            test_subchannel(channel_key_a, token, Some(1)),
            test_subchannel(channel_key_b, token, Some(0)),
        ]);
        let mut scanner = BufferedNoteScanner::new();
        let budget = IoBudget::new(100);

        // First call: block 10 with both of A's notes.
        let (block_number, notes) = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(block_number, 10);
        assert_eq!(notes.len(), 2);

        // Second call: block 5 with B's note.
        let (block_number, notes) = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(block_number, 5);
        assert_eq!(notes.len(), 1);

        // Exhausted.
        let result = scanner
            .next_block(&backend, &mut cursor, &budget)
            .await
            .unwrap();
        assert!(result.is_none());
    }
}
