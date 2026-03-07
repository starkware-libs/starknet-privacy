//! Backward history sync function.

use std::collections::BTreeMap;

use starknet_types_core::felt::Felt;

use super::types::{CreateNoteEvent, HistoryCursor, HistoryEventSource};
use crate::discovery::DiscoveryError;
use crate::io_budget::IoBudget;
use crate::privacy_pool::decryption::{decrypt_packed_amount, OPEN_NOTE_SALT};
use crate::privacy_pool::hashes::compute_note_id;
use crate::privacy_pool::views::IViews;

/// Scans history backward across multiple event sources, returning events grouped
/// by block number in descending order. Returns up to `max_items` complete block
/// groups. Updates `cursor` in place for the next call.
pub async fn fetch_aggregated_note_events<S: IViews>(
    pool: &S,
    cursor: &mut HistoryCursor,
    max_items: usize,
    budget: &IoBudget,
) -> Result<BTreeMap<u64, Vec<CreateNoteEvent>>, DiscoveryError> {
    // source_index → (block_number, event) for the next unconsumed event per source.
    let mut buffered_events: BTreeMap<usize, (u64, CreateNoteEvent)> = BTreeMap::new();
    // block_number → events, accumulated in descending block order.
    let mut completed_blocks: BTreeMap<u64, Vec<CreateNoteEvent>> = BTreeMap::new();

    loop {
        fill_buffers(pool, &cursor.event_sources, &mut buffered_events, budget).await?;

        let Some(max_block_number) = buffered_events
            .values()
            .map(|(block_number, _)| *block_number)
            .max()
        else {
            break;
        };

        // Drain events at max_block_number into completed_blocks, keep the rest.
        let block_events = completed_blocks.entry(max_block_number).or_default();
        for (source_index, (block_number, event)) in std::mem::take(&mut buffered_events) {
            if block_number == max_block_number {
                block_events.push(event);
                let source = &mut cursor.event_sources[source_index];
                source.next_index = source.next_index.and_then(|i| i.checked_sub(1));
            } else {
                buffered_events.insert(source_index, (block_number, event));
            }
        }

        if completed_blocks.len() >= max_items {
            break;
        }
    }

    Ok(completed_blocks)
}

/// Fills empty buffers by batch-reading notes for all event sources that need data.
///
/// Each source needs 1 note read. Notes are fetched in a single `IViews` call.
async fn fill_buffers<S: IViews>(
    pool: &S,
    event_sources: &[HistoryEventSource],
    buffered_events: &mut BTreeMap<usize, (u64, CreateNoteEvent)>,
    budget: &IoBudget,
) -> Result<(), DiscoveryError> {
    // Sources that have no buffered event yet and haven't been exhausted.
    let active_sources: Vec<_> = event_sources
        .iter()
        .enumerate()
        .filter(|(source_index, _)| !buffered_events.contains_key(source_index))
        .filter_map(|(source_index, source)| {
            let next_note_index = source.next_index?;
            let next_note_id = compute_note_id(&source.channel_key, source.token, next_note_index);
            Some((source_index, next_note_index, next_note_id))
        })
        .collect();

    let cost = active_sources.len();
    if cost > 0 && !budget.consume(cost) {
        return Err(DiscoveryError::InsufficientBudget {
            needed: cost,
            available: budget.remaining(),
        });
    }

    let note_ids: Vec<_> = active_sources
        .iter()
        .map(|&(_, _, next_note_id)| next_note_id)
        .collect();
    let note_results = pool.get_notes_batch_with_block(&note_ids).await?;

    for (&(source_index, next_note_index, next_note_id), note_result) in
        active_sources.iter().zip(&note_results)
    {
        if let Some(entry) = decode_note_event(
            &event_sources[source_index],
            next_note_index,
            next_note_id,
            note_result.value,
            note_result.block_number,
        ) {
            buffered_events.insert(source_index, entry);
        }
    }

    Ok(())
}

/// Decodes a note value into a `CreateNoteEvent` with its block number.
/// Returns `None` if the note doesn't exist (value is zero).
fn decode_note_event(
    source: &HistoryEventSource,
    note_index: u64,
    note_id: Felt,
    note_value: Felt,
    block_number: u64,
) -> Option<(u64, CreateNoteEvent)> {
    if note_value == Felt::ZERO {
        return None;
    }
    let (amount, salt) =
        decrypt_packed_amount(note_value, &source.channel_key, source.token, note_index);
    let is_open = salt == OPEN_NOTE_SALT;
    Some((
        block_number,
        CreateNoteEvent {
            channel_kind: source.channel_kind,
            token: source.token,
            note_index,
            note_id,
            amount,
            counterparty: source.counterparty,
            is_open,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::types::ChannelKind;
    use crate::io_budget::IoBudget;
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

    /// Packs an open-note amount (salt=1) into the format stored on-chain.
    fn pack_open_amount(amount: u128) -> Felt {
        Felt::from(OPEN_NOTE_SALT) * Felt::from(1u128 << 64) * Felt::from(1u128 << 64)
            + Felt::from(amount)
    }

    /// Inserts a note into the mock backend at the given index and block.
    fn insert_note(
        backend: &mut MockBackend,
        channel_key: &SecretFelt,
        token: Felt,
        note_index: u64,
        amount: u128,
        block_number: u64,
    ) {
        let note_id = compute_note_id(channel_key, token, note_index);
        let note_slot = storage_slots::notes(note_id);
        let packed = pack_open_amount(amount);
        backend.insert_with_block(note_slot, packed, block_number);
    }

    #[tokio::test]
    async fn empty_scan() {
        let backend = MockBackend::empty();
        let mut cursor = HistoryCursor {
            event_sources: vec![],
        };

        let result = fetch_aggregated_note_events(&backend, &mut cursor, 10, &IoBudget::new(100))
            .await
            .unwrap();

        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn empty_scan_all_none_indices() {
        let backend = MockBackend::empty();
        let mut cursor = HistoryCursor {
            event_sources: vec![HistoryEventSource {
                channel_key: test_channel_key(),
                token: test_token(),
                channel_kind: ChannelKind::Incoming,
                counterparty: Felt::ZERO,
                next_index: None,
            }],
        };

        let result = fetch_aggregated_note_events(&backend, &mut cursor, 10, &IoBudget::new(100))
            .await
            .unwrap();

        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn single_creation() {
        let channel_key = test_channel_key();
        let token = test_token();
        let mut backend = MockBackend::empty();

        insert_note(&mut backend, &channel_key, token, 0, 100, 10);

        let mut cursor = HistoryCursor {
            event_sources: vec![HistoryEventSource {
                channel_key: channel_key.clone(),
                token,
                channel_kind: ChannelKind::Incoming,
                counterparty: Felt::ZERO,
                next_index: Some(0),
            }],
        };

        let result = fetch_aggregated_note_events(&backend, &mut cursor, 10, &IoBudget::new(100))
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        let events = result.get(&10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].channel_kind, ChannelKind::Incoming);
        assert_eq!(events[0].amount, 100);
        assert_eq!(events[0].note_index, 0);
        assert!(events[0].is_open);

        assert_eq!(cursor.event_sources[0].next_index, None);
    }

    #[tokio::test]
    async fn events_grouped_by_block() {
        let channel_key_a = SecretFelt::new(Felt::from_hex_unchecked("0xA1"));
        let channel_key_b = SecretFelt::new(Felt::from_hex_unchecked("0xB2"));
        let token = test_token();
        let mut backend = MockBackend::empty();

        insert_note(&mut backend, &channel_key_a, token, 0, 100, 50);
        insert_note(&mut backend, &channel_key_b, token, 0, 200, 50);

        let mut cursor = HistoryCursor {
            event_sources: vec![
                HistoryEventSource {
                    channel_key: channel_key_a,
                    token,
                    channel_kind: ChannelKind::Incoming,
                    counterparty: Felt::ZERO,
                    next_index: Some(0),
                },
                HistoryEventSource {
                    channel_key: channel_key_b,
                    token,
                    channel_kind: ChannelKind::SelfChannel,
                    counterparty: Felt::ZERO,
                    next_index: Some(0),
                },
            ],
        };

        let result = fetch_aggregated_note_events(&backend, &mut cursor, 10, &IoBudget::new(100))
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        let events = result.get(&50).unwrap();
        assert_eq!(events.len(), 2);
    }

    #[tokio::test]
    async fn priority_merge_order() {
        let channel_key_a = SecretFelt::new(Felt::from_hex_unchecked("0xA1"));
        let channel_key_b = SecretFelt::new(Felt::from_hex_unchecked("0xB2"));
        let token = test_token();
        let mut backend = MockBackend::empty();

        insert_note(&mut backend, &channel_key_a, token, 0, 100, 100);
        insert_note(&mut backend, &channel_key_b, token, 0, 200, 80);

        let mut cursor = HistoryCursor {
            event_sources: vec![
                HistoryEventSource {
                    channel_key: channel_key_a,
                    token,
                    channel_kind: ChannelKind::Incoming,
                    counterparty: Felt::ZERO,
                    next_index: Some(0),
                },
                HistoryEventSource {
                    channel_key: channel_key_b,
                    token,
                    channel_kind: ChannelKind::Incoming,
                    counterparty: Felt::ZERO,
                    next_index: Some(0),
                },
            ],
        };

        let result = fetch_aggregated_note_events(&backend, &mut cursor, 10, &IoBudget::new(100))
            .await
            .unwrap();

        let blocks: Vec<u64> = result.keys().rev().copied().collect();
        assert_eq!(blocks, vec![100, 80]);
    }

    #[tokio::test]
    async fn drain_same_block() {
        let channel_key = test_channel_key();
        let token = test_token();
        let mut backend = MockBackend::empty();

        // Two notes in the same subchannel at the same block.
        insert_note(&mut backend, &channel_key, token, 0, 10, 42);
        insert_note(&mut backend, &channel_key, token, 1, 20, 42);

        let mut cursor = HistoryCursor {
            event_sources: vec![HistoryEventSource {
                channel_key: channel_key.clone(),
                token,
                channel_kind: ChannelKind::Incoming,
                counterparty: Felt::ZERO,
                next_index: Some(1),
            }],
        };

        let result = fetch_aggregated_note_events(&backend, &mut cursor, 10, &IoBudget::new(100))
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        let events = result.get(&42).unwrap();
        assert_eq!(events.len(), 2);
        assert!(cursor.event_sources[0].next_index.is_none());
    }

    #[tokio::test]
    async fn max_items_limits() {
        let channel_key = test_channel_key();
        let token = test_token();
        let mut backend = MockBackend::empty();

        // 5 notes at 5 different blocks.
        for note_index in 0..5u64 {
            let block_number = (note_index + 1) * 10;
            insert_note(
                &mut backend,
                &channel_key,
                token,
                note_index,
                100,
                block_number,
            );
        }

        let mut cursor = HistoryCursor {
            event_sources: vec![HistoryEventSource {
                channel_key: channel_key.clone(),
                token,
                channel_kind: ChannelKind::Incoming,
                counterparty: Felt::ZERO,
                next_index: Some(4),
            }],
        };

        let result = fetch_aggregated_note_events(&backend, &mut cursor, 2, &IoBudget::new(100))
            .await
            .unwrap();

        assert_eq!(result.len(), 2);
        // Should contain the 2 highest blocks: 50 and 40.
        assert!(result.contains_key(&50));
        assert!(result.contains_key(&40));
    }

    #[tokio::test]
    async fn outgoing_creation() {
        let channel_key = test_channel_key();
        let token = test_token();
        let mut backend = MockBackend::empty();

        insert_note(&mut backend, &channel_key, token, 0, 75, 15);

        let mut cursor = HistoryCursor {
            event_sources: vec![HistoryEventSource {
                channel_key: channel_key.clone(),
                token,
                channel_kind: ChannelKind::Outgoing,
                counterparty: Felt::ZERO,
                next_index: Some(0),
            }],
        };

        let result = fetch_aggregated_note_events(&backend, &mut cursor, 10, &IoBudget::new(100))
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        let events = result.get(&15).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].channel_kind, ChannelKind::Outgoing);
        assert_eq!(events[0].amount, 75);
    }

    #[tokio::test]
    async fn sequential_calls() {
        let channel_key = test_channel_key();
        let token = test_token();
        let mut backend = MockBackend::empty();

        // 4 notes at blocks 10, 20, 30, 40.
        for note_index in 0..4u64 {
            insert_note(
                &mut backend,
                &channel_key,
                token,
                note_index,
                100,
                (note_index + 1) * 10,
            );
        }

        let mut cursor = HistoryCursor {
            event_sources: vec![HistoryEventSource {
                channel_key: channel_key.clone(),
                token,
                channel_kind: ChannelKind::Incoming,
                counterparty: Felt::ZERO,
                next_index: Some(3),
            }],
        };

        // First call: get top 2 blocks.
        let result1 = fetch_aggregated_note_events(&backend, &mut cursor, 2, &IoBudget::new(100))
            .await
            .unwrap();
        assert_eq!(result1.len(), 2);
        assert!(result1.contains_key(&40));
        assert!(result1.contains_key(&30));

        // Cursor should have advanced: next_index should be Some(1)
        // (index 3→block40, index 2→block30 consumed, next is index 1).
        assert_eq!(cursor.event_sources[0].next_index, Some(1));

        // Second call: get next 2 blocks.
        let result2 = fetch_aggregated_note_events(&backend, &mut cursor, 2, &IoBudget::new(100))
            .await
            .unwrap();
        assert_eq!(result2.len(), 2);
        assert!(result2.contains_key(&20));
        assert!(result2.contains_key(&10));

        assert_eq!(cursor.event_sources[0].next_index, None);
    }

    #[tokio::test]
    async fn max_items_zero_returns_empty() {
        let backend = MockBackend::empty();
        let mut cursor = HistoryCursor {
            event_sources: vec![HistoryEventSource {
                channel_key: test_channel_key(),
                token: test_token(),
                channel_kind: ChannelKind::Incoming,
                counterparty: Felt::ZERO,
                next_index: Some(0),
            }],
        };

        let result = fetch_aggregated_note_events(&backend, &mut cursor, 0, &IoBudget::new(100))
            .await
            .unwrap();

        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn insufficient_budget() {
        let channel_key = test_channel_key();
        let token = test_token();
        let mut backend = MockBackend::empty();

        insert_note(&mut backend, &channel_key, token, 0, 100, 10);

        let mut cursor = HistoryCursor {
            event_sources: vec![HistoryEventSource {
                channel_key: channel_key.clone(),
                token,
                channel_kind: ChannelKind::Incoming,
                counterparty: Felt::ZERO,
                next_index: Some(0),
            }],
        };

        // Budget of 0 — cannot afford even one note read.
        let result =
            fetch_aggregated_note_events(&backend, &mut cursor, 10, &IoBudget::new(0)).await;

        assert!(matches!(
            result,
            Err(DiscoveryError::InsufficientBudget { .. })
        ));
    }

    #[tokio::test]
    async fn budget_consumed_across_iterations() {
        let channel_key = test_channel_key();
        let token = test_token();
        let mut backend = MockBackend::empty();

        // 3 notes at 3 different blocks — each fill_buffers costs 1 slot read.
        for note_index in 0..3u64 {
            insert_note(
                &mut backend,
                &channel_key,
                token,
                note_index,
                100,
                (note_index + 1) * 10,
            );
        }

        let mut cursor = HistoryCursor {
            event_sources: vec![HistoryEventSource {
                channel_key: channel_key.clone(),
                token,
                channel_kind: ChannelKind::Incoming,
                counterparty: Felt::ZERO,
                next_index: Some(2),
            }],
        };

        // Budget of 2 — enough for 2 fill_buffers calls (initial + 1 refill),
        // but the 3rd refill should fail.
        let result =
            fetch_aggregated_note_events(&backend, &mut cursor, 10, &IoBudget::new(2)).await;

        assert!(matches!(
            result,
            Err(DiscoveryError::InsufficientBudget { .. })
        ));
    }
}
