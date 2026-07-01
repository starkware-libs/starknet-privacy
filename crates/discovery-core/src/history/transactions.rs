//! Coordinated backward history scan.
//!
//! Orchestrates note reading, block event fetching, and withdrawal event
//! fetching, then merges results into a unified transaction list.

use std::collections::HashMap;

use starknet_core::types::{BlockId, BlockTag};
use starknet_types_core::felt::Felt;
use tracing::{debug, trace};

use super::notes::BufferedNoteScanner;
use super::types::{HistoryCursor, HistoryNote, HistoryTransaction};
use crate::discovery::{
    DiscoveryError, COST_BLOCK_EVENTS_QUERY, COST_EVENTS_CHUNK, COST_NOTE, COST_PUBLIC_KEY,
    EVENTS_COST_CHUNK_SIZE,
};
use crate::io_budget::IoBudget;
use crate::privacy_pool::events::{IEvents, PrivacyPoolEventContent};
use crate::privacy_pool::views::IViews;

/// Outcome of one [`process_next_block`] iteration.
enum ScanStep {
    /// Committed a gap window and its anchoring note block; keep scanning.
    Advanced,
    /// Made forward progress (a partial gap window, or stopped before a note to
    /// honor the page limit / preserve budget) and the page should end. The
    /// cursor already reflects the committed work; the next page resumes from it.
    Halted,
    /// No more notes to scan; the backward walk is complete.
    Exhausted,
}

/// Fetches history transactions by coordinating note reads and event fetches.
///
/// Walks note blocks newest-first. Each iteration ([`process_next_block`]):
/// 1. Peek the next note block `K` without draining it.
/// 2. Scan withdrawals in the gap `(K, upper]` **first**, in a budget-bounded
///    top-down window via [`fetch_gap_withdrawals_chunked`], advancing the
///    cursor per window so a far-behind account makes forward progress instead
///    of charging an unbounded range at once.
/// 3. Once the gap is fully covered, drain block `K` and fetch its block events
///    via [`fetch_aggregated_block_events`].
///
/// Budget is consumed incrementally; the scan stops at the first iteration that
/// cannot make further progress within budget, with the cursor left at the
/// frontier so the next page continues. Returns transactions sorted by
/// `block_number` descending.
pub async fn fetch_transactions<B: IViews + IEvents>(
    backend: &B,
    user_address: Felt,
    cursor: &mut HistoryCursor,
    max_transactions: usize,
    budget: &IoBudget,
) -> Result<Vec<HistoryTransaction>, DiscoveryError> {
    debug!(
        num_subchannels = cursor.subchannels.len(),
        begin_block_number = ?cursor.begin_block_number,
        snapshot_block_id = ?backend.block_id(),
        budget_remaining = budget.remaining(),
        max_transactions,
        "history: starting fetch_transactions"
    );

    let mut note_scanner = BufferedNoteScanner::new();
    let mut transactions: HashMap<Felt, HistoryTransaction> = HashMap::new();
    let mut budget_error: Option<DiscoveryError> = None;
    let mut scanner_complete = false;

    loop {
        if transactions.len() >= max_transactions {
            trace!("history: hit max_transactions limit");
            break;
        }

        match process_next_block(
            backend,
            user_address,
            &mut note_scanner,
            cursor,
            max_transactions,
            budget,
            &mut transactions,
        )
        .await
        {
            Ok(ScanStep::Advanced) => continue,
            Ok(ScanStep::Halted) => break,
            Ok(ScanStep::Exhausted) => {
                scanner_complete = true;
                break;
            }
            Err(e) if matches!(e, DiscoveryError::InsufficientBudget { .. }) => {
                budget_error = Some(e);
                break;
            }
            Err(e) => return Err(e),
        }
    }

    // No orphan filtering is needed: the gap-first scan advances
    // `cursor.begin_block_number` atomically with every committed transaction
    // (gap windows set it to `window_bottom - 1`; note blocks to `K - 1`), so
    // every collected transaction sits strictly above the final cursor bound.
    let mut result: Vec<HistoryTransaction> = transactions.into_values().collect();

    // Append the synthetic registration transaction when the note scan is
    // complete and there is room on this page. When the page is already full,
    // keep history_complete false so the client fetches one more page.
    // InsufficientBudget from fetch_registration also defers to the next page.
    if scanner_complete && result.len() < max_transactions {
        match fetch_registration(backend, user_address, budget).await {
            Ok(Some(registration)) => result.push(registration),
            Ok(None) => {}
            Err(e) if matches!(e, DiscoveryError::InsufficientBudget { .. }) => {
                budget_error = Some(e);
            }
            Err(e) => return Err(e),
        }
        cursor.history_complete = budget_error.is_none();
    } else {
        cursor.history_complete = false;
    }

    result.sort_by_key(|tx| std::cmp::Reverse(tx.block_number));

    debug!(
        num_transactions = result.len(),
        history_complete = cursor.history_complete,
        budget_remaining = budget.remaining(),
        begin_block_number = ?cursor.begin_block_number,
        "history: fetch_transactions done"
    );

    if result.is_empty() {
        if let Some(error) = budget_error {
            return Err(error);
        }
    }

    Ok(result)
}

/// Runs one iteration of the backward scan: scans the gap above the next note
/// block first (chunked, budget-bounded), then drains and processes that note
/// block once its gap is fully covered. Advances `cursor.begin_block_number`
/// for every committed step.
///
/// Returns:
/// - [`ScanStep::Advanced`] — committed a note block (and its gap); keep going.
/// - [`ScanStep::Halted`] — committed forward progress but the page should end
///   (gap only partially covered within budget, or stopped before the note to
///   honor `max_transactions` / preserve note-step budget).
/// - [`ScanStep::Exhausted`] — no more notes.
///
/// `InsufficientBudget` from buffer fills / block-event fetches propagates via `?`.
async fn process_next_block<B: IViews + IEvents>(
    backend: &B,
    user_address: Felt,
    note_scanner: &mut BufferedNoteScanner,
    cursor: &mut HistoryCursor,
    max_transactions: usize,
    budget: &IoBudget,
    transactions: &mut HashMap<Felt, HistoryTransaction>,
) -> Result<ScanStep, DiscoveryError> {
    // Resolve the scan upper bound. On a fresh scan (`None`) use the snapshot's
    // pinned `block_id` for the RPC window top so tag semantics (e.g.
    // PreConfirmed) include head-of-chain withdrawals; `block_number()` gives
    // the matching concrete number for window arithmetic.
    let (upper, upper_block_id) = match cursor.begin_block_number {
        Some(n) => (n, BlockId::Number(n)),
        None => (backend.block_number(), backend.block_id()),
    };

    // Peek the next note block, draining and discarding any note whose block
    // sits *above* the upper bound. Both `cursor.begin_block_number` and the
    // snapshot are user-controlled, so a stale/adversarial cursor may surface
    // notes above the bound; skip them without processing.
    let note_block = loop {
        match note_scanner
            .peek_next_block(backend, cursor, budget)
            .await?
        {
            None => return Ok(ScanStep::Exhausted),
            Some(block_number) if block_number <= upper => break block_number,
            Some(block_number) => {
                trace!(
                    block_number,
                    upper,
                    "history: skipping note above upper bound"
                );
                note_scanner.next_block(backend, cursor, budget).await?;
            }
        }
    };

    // Scan the gap strictly above the note block first. Doing this before
    // draining the note keeps block `K` out of the gap range, so a budget
    // failure mid-gap cannot make a later page re-scan (and double-count) the
    // note block's withdrawals. `saturating_add` guards the unreachable
    // `note_block == u64::MAX` (block numbers come from chain storage).
    let gap_floor = note_block.saturating_add(1);
    if upper >= gap_floor {
        let window_bottom = fetch_gap_withdrawals_chunked(
            backend,
            user_address,
            gap_floor,
            upper,
            upper_block_id,
            budget,
            transactions,
        )
        .await?;
        cursor.begin_block_number = Some(window_bottom.saturating_sub(1));
        if window_bottom > gap_floor {
            // Budget bounded the window above the note; resume next page.
            return Ok(ScanStep::Halted);
        }
    }

    // Gap fully covered down to the note block. Stop before the note when the
    // page is already full, or when the remaining budget can't cover the note
    // step (block-events plus one scanner refill across all subchannels). In
    // either case the note is deferred *without* draining it, so the cursor
    // stays at the note block and the next page retries it.
    let note_step_budget = COST_BLOCK_EVENTS_QUERY + cursor.subchannels.len() * COST_NOTE;
    if transactions.len() >= max_transactions || budget.remaining() < note_step_budget {
        return Ok(ScanStep::Halted);
    }

    let Some((block_number, block_notes)) =
        note_scanner.next_block(backend, cursor, budget).await?
    else {
        // Unreachable for a single-threaded scan: the block peeked above is
        // still buffered. Treat a vanished block as exhaustion rather than
        // relying on scanner internals.
        return Ok(ScanStep::Exhausted);
    };

    trace!(
        block_number,
        num_notes = block_notes.len(),
        budget_remaining = budget.remaining(),
        "history: processing note block"
    );

    fetch_aggregated_block_events(
        backend,
        user_address,
        block_number,
        block_notes,
        budget,
        transactions,
    )
    .await?;
    cursor.begin_block_number = Some(block_number.saturating_sub(1));

    Ok(ScanStep::Advanced)
}

/// Fetches all events for a block and groups them into `transactions`.
///
/// Only creates transactions for notes that match a `NoteCreated` event.
/// Auxiliary events (Deposit, Withdrawal, OpenNoteDeposited) are attached only
/// to transactions already created from matched notes.
///
/// Deposits are filtered by `user_address` — only deposits made by the querying
/// account are included. Withdrawals are **not** filtered because
/// `enc_user_addr` is encrypted; only `to_address` (recipient) is public.
/// This means: (a) if account A withdraws to B, B incorrectly sees it as
/// their withdrawal when B has matched notes in the same tx; (b) in multi-user
/// transactions, unrelated withdrawals are attached to any user with matched
/// notes.
///
/// Returns `Err(InsufficientBudget)` if budget is insufficient (no work done).
async fn fetch_aggregated_block_events<E: IEvents>(
    backend: &E,
    user_address: Felt,
    block_number: u64,
    notes: Vec<HistoryNote>,
    budget: &IoBudget,
    transactions: &mut HashMap<Felt, HistoryTransaction>,
) -> Result<(), DiscoveryError> {
    budget.try_consume(COST_BLOCK_EVENTS_QUERY)?;

    let mut block_events = backend
        .get_block_events(BlockId::Number(block_number))
        .await?;

    // If the by-number fetch returned nothing, the block may still be
    // pre-confirmed (events only accessible by tag). Retry with the
    // pre_confirmed tag.
    if block_events.is_empty() {
        debug!(
            block_number,
            "block_events: no events by number, retrying with pre_confirmed tag"
        );
        block_events = backend
            .get_block_events(BlockId::Tag(BlockTag::PreConfirmed))
            .await?;
    }

    // Build note_id → tx_hash index from note creation events.
    let mut note_id_to_tx_hash: HashMap<Felt, Felt> = HashMap::new();
    for event in &block_events {
        let note_id = match &event.content {
            PrivacyPoolEventContent::EncNoteCreated(e) => e.note_id,
            PrivacyPoolEventContent::OpenNoteDeposited(e) => e.note_id,
            _ => continue,
        };
        note_id_to_tx_hash.insert(note_id, event.transaction_hash);
    }

    trace!(
        block_number,
        num_input_notes = notes.len(),
        num_note_created_events = note_id_to_tx_hash.len(),
        num_auxiliary_events = block_events.len(),
        "block_events: pre-merge"
    );

    for note in notes {
        if let Some(&transaction_hash) = note_id_to_tx_hash.get(&note.note_id) {
            let tx = transactions
                .entry(transaction_hash)
                .or_insert_with(|| HistoryTransaction::new(block_number, transaction_hash));
            tx.notes.push(note);
        } else {
            debug!(
                note_id = %format!("{:#x}", note.note_id),
                block_number,
                "history: no matching event found for note"
            );
        }
    }

    // Attach auxiliary events only to matched transactions.
    for event in block_events {
        if let Some(tx) = transactions.get_mut(&event.transaction_hash) {
            match event.content {
                // Filter by user_address: deposits from other addresses in the
                // same tx are deposit+transfer flows — including them would
                // double-count balances.
                PrivacyPoolEventContent::Deposit(deposit) => {
                    if deposit.user_address == user_address {
                        tx.deposits.push(deposit);
                    }
                }
                // Withdrawals cannot be filtered by sender because
                // `enc_user_addr` is encrypted; only `to_address` is public.
                // See doc comment on this function for implications.
                PrivacyPoolEventContent::Withdrawal(withdrawal) => {
                    tx.withdrawals.push(withdrawal);
                }
                PrivacyPoolEventContent::OpenNoteDeposited(open_note) => {
                    tx.open_note_deposits.push(open_note);
                }
                PrivacyPoolEventContent::EncNoteCreated(_)
                | PrivacyPoolEventContent::ViewingKeySet(_) => {}
            }
        }
    }

    Ok(())
}

/// Scans withdrawals in the gap `[from_block, to_block]` for `user_address`,
/// top-down, consuming **at most** the budget available rather than charging the
/// whole range at once.
///
/// These are standalone withdrawals (in the gap above a note block) filtered by
/// `user_address` at the RPC level (`get_withdrawal_events`). The
/// withdrawal-attribution caveats from [`fetch_aggregated_block_events`] don't
/// apply here, since gap-range withdrawals are already keyed on the querying
/// account's address.
///
/// Charges `COST_EVENTS_CHUNK` per `EVENTS_COST_CHUNK_SIZE`-block chunk, granting
/// as many whole chunks as the budget allows ([`IoBudget::consume_up_to`]), then
/// issues one `get_withdrawal_events` over the affordable top window
/// `[window_bottom, to_block]` and groups matched withdrawals into `transactions`.
///
/// Returns the lowest block scanned (`window_bottom`); the caller advances the
/// cursor to `window_bottom - 1`. When the full gap was covered in this call,
/// `window_bottom == from_block`; otherwise it is above `from_block` and the
/// caller resumes the remainder on the next page.
///
/// `to_block_id` is the `BlockId` used for the window top, so a fresh scan can
/// pass the snapshot's pinned tag (e.g. `PreConfirmed`) to include
/// head-of-chain withdrawals, while window arithmetic uses the resolved
/// `to_block` number.
///
/// Caller guarantees `from_block <= to_block`. Returns `Err(InsufficientBudget)`
/// only when not even one chunk is affordable (no forward progress possible).
async fn fetch_gap_withdrawals_chunked<E: IEvents>(
    backend: &E,
    user_address: Felt,
    from_block: u64,
    to_block: u64,
    to_block_id: BlockId,
    budget: &IoBudget,
    transactions: &mut HashMap<Felt, HistoryTransaction>,
) -> Result<u64, DiscoveryError> {
    let num_blocks = to_block - from_block + 1;
    let chunks_needed = num_blocks.div_ceil(EVENTS_COST_CHUNK_SIZE as u64);
    // Cap to usize for `consume_up_to`; the grant is bounded by the budget
    // regardless, so a huge `chunks_needed` just means "scan as much as we can".
    let chunks_needed = usize::try_from(chunks_needed).unwrap_or(usize::MAX);

    let (chunks_granted, _) = budget.consume_up_to(chunks_needed, COST_EVENTS_CHUNK);
    if chunks_granted == 0 {
        return Err(DiscoveryError::InsufficientBudget {
            needed: COST_EVENTS_CHUNK,
            available: budget.remaining(),
        });
    }

    // Top-down window: scan the highest `chunks_granted` chunks of the gap,
    // clamped to the gap floor.
    let granted_span = (chunks_granted as u64) * (EVENTS_COST_CHUNK_SIZE as u64);
    let window_bottom = to_block.saturating_sub(granted_span - 1).max(from_block);

    let events = backend
        .get_withdrawal_events(user_address, BlockId::Number(window_bottom), to_block_id)
        .await?;

    trace!(
        from_block,
        to_block,
        window_bottom,
        chunks_granted,
        num_withdrawal_events = events.len(),
        "withdrawal_events: chunked window fetched"
    );

    for event in events {
        let tx = transactions
            .entry(event.transaction_hash)
            .or_insert_with(|| HistoryTransaction::new(event.block_number, event.transaction_hash));
        if let PrivacyPoolEventContent::Withdrawal(withdrawal) = event.content {
            tx.withdrawals.push(withdrawal);
        }
    }

    Ok(window_bottom)
}

/// Fetches the synthetic registration transaction for the user.
///
/// Reads the `public_key` storage slot with block info to find when the user
/// registered, then queries the `ViewingKeySet` event at that block to get the
/// real transaction hash.
///
/// Returns `Ok(None)` when the registration block is unavailable (block 0).
/// Budget and backend errors propagate to the caller.
async fn fetch_registration<B: IViews + IEvents>(
    backend: &B,
    user_address: Felt,
    budget: &IoBudget,
) -> Result<Option<HistoryTransaction>, DiscoveryError> {
    budget.try_consume(COST_PUBLIC_KEY)?;
    let storage_result = backend.get_public_key_with_block(user_address).await?;
    if storage_result.last_update_block == 0 {
        return Ok(None);
    }
    let block_number = storage_result.last_update_block;

    budget.try_consume(COST_EVENTS_CHUNK)?;
    let block_id = BlockId::Number(block_number);
    let events = backend
        .get_viewing_key_set_events(user_address, block_id, block_id)
        .await?;
    let transaction_hash = events
        .first()
        .map(|event| event.transaction_hash)
        .ok_or_else(|| {
            DiscoveryError::EventError(format!(
                "ViewingKeySet event not found at block {block_number} for user {user_address:#x}"
            ))
        })?;

    let mut registration = HistoryTransaction::new(block_number, transaction_hash);
    registration.registered_pubkey = Some(storage_result.value);
    Ok(Some(registration))
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use starknet_core::types::BlockId;
    use starknet_core::utils::starknet_keccak;

    use super::*;
    use crate::discovery::{COST_EVENTS_CHUNK, COST_NOTE};
    use crate::events_backend::{mock_event, EmittedEvent, MockEventBackend, RawEventAccess};
    use crate::history::types::{ChannelKind, HistorySubchannel};
    use crate::io_budget::IoBudget;
    use crate::privacy_pool::hashes::compute_note_id;
    use crate::privacy_pool::storage_slots;
    use crate::privacy_pool::types::SecretFelt;
    use crate::storage_backend::{MockBackend, RawStorageAccess, StorageError};
    use starknet_core::types::StorageResult;

    const ADDRESS: Felt = Felt::from_hex_unchecked("0xABCD");
    const OTHER_ADDRESS: Felt = Felt::from_hex_unchecked("0x9999");
    const TOKEN: Felt = Felt::from_hex_unchecked("0x12345");
    const TX_HASH_1: Felt = Felt::from_hex_unchecked("0x1001");
    const TX_HASH_2: Felt = Felt::from_hex_unchecked("0x1002");
    const TX_HASH_REG: Felt = Felt::from_hex_unchecked("0x2001");
    const NOTE_ID: Felt = Felt::from_hex_unchecked("0xAABB");
    const PACKED: Felt = Felt::from_hex_unchecked("0xDEAD");

    fn channel_key() -> SecretFelt {
        SecretFelt::new(Felt::from_hex_unchecked("0xCAFE"))
    }

    fn test_note(note_id: Felt) -> HistoryNote {
        HistoryNote {
            channel_kind: ChannelKind::Incoming,
            token: TOKEN,
            note_index: 0,
            note_id,
            counterparty: Felt::from_hex_unchecked("0xBEEF"),
            amount: 100,
            salt: 42,
        }
    }

    fn enc_note_created_event(
        note_id: Felt,
        block_number: u64,
        transaction_hash: Felt,
    ) -> EmittedEvent {
        let selector = starknet_keccak(b"EncNoteCreated");
        mock_event(
            block_number,
            transaction_hash,
            vec![selector, note_id],
            vec![Felt::from(0xDEADu64)],
        )
    }

    fn viewing_key_set_event(
        user_address: Felt,
        pubkey: Felt,
        block_number: u64,
        transaction_hash: Felt,
    ) -> EmittedEvent {
        let selector = starknet_keccak(b"ViewingKeySet");
        mock_event(
            block_number,
            transaction_hash,
            vec![selector, user_address, pubkey],
            vec![Felt::ZERO, Felt::ZERO, Felt::ZERO],
        )
    }

    fn deposit_event(amount: u64, block_number: u64, transaction_hash: Felt) -> EmittedEvent {
        deposit_event_from(ADDRESS, amount, block_number, transaction_hash)
    }

    fn deposit_event_from(
        user_address: Felt,
        amount: u64,
        block_number: u64,
        transaction_hash: Felt,
    ) -> EmittedEvent {
        let selector = starknet_keccak(b"Deposit");
        mock_event(
            block_number,
            transaction_hash,
            vec![selector, user_address, TOKEN],
            vec![Felt::from(amount)],
        )
    }

    fn withdrawal_event(amount: u64, block_number: u64, transaction_hash: Felt) -> EmittedEvent {
        let selector = starknet_keccak(b"Withdrawal");
        mock_event(
            block_number,
            transaction_hash,
            vec![selector, ADDRESS, TOKEN],
            vec![Felt::ZERO, Felt::ZERO, Felt::ZERO, Felt::from(amount)],
        )
    }

    /// Composite mock backend that delegates storage to `MockBackend` and events
    /// to `MockEventBackend`.
    struct MockHistoryBackend {
        storage: MockBackend,
        events: MockEventBackend,
    }

    #[async_trait]
    impl RawStorageAccess for MockHistoryBackend {
        async fn read_slot(&self, slot: Felt) -> Result<Felt, StorageError> {
            self.storage.read_slot(slot).await
        }

        async fn read_slots(&self, slots: Vec<Felt>) -> Result<Vec<Felt>, StorageError> {
            self.storage.read_slots(slots).await
        }

        async fn read_slots_with_block(
            &self,
            slots: Vec<Felt>,
        ) -> Result<Vec<StorageResult>, StorageError> {
            self.storage.read_slots_with_block(slots).await
        }
    }

    #[async_trait]
    impl RawEventAccess for MockHistoryBackend {
        async fn get_events(
            &self,
            keys: &[Vec<Felt>],
            from_block: BlockId,
            to_block: BlockId,
        ) -> Result<Vec<EmittedEvent>, StorageError> {
            self.events.get_events(keys, from_block, to_block).await
        }

        fn block_id(&self) -> BlockId {
            RawEventAccess::block_id(&self.events)
        }

        fn block_number(&self) -> u64 {
            RawEventAccess::block_number(&self.events)
        }
    }

    /// Builder for test fixtures with a single shared channel key.
    struct FixtureBuilder {
        storage: MockBackend,
        events: Vec<EmittedEvent>,
        key: SecretFelt,
    }

    impl FixtureBuilder {
        fn new() -> Self {
            Self {
                storage: MockBackend::empty(),
                events: Vec::new(),
                key: channel_key(),
            }
        }

        fn note(mut self, index: u64, block: u64, tx_hash: Felt) -> Self {
            let note_id = compute_note_id(&self.key, TOKEN, index);
            self.storage
                .insert_with_block(storage_slots::notes(note_id), PACKED, block);
            self.events
                .push(enc_note_created_event(note_id, block, tx_hash));
            self
        }

        fn deposit(mut self, amount: u64, block: u64, tx_hash: Felt) -> Self {
            self.events.push(deposit_event(amount, block, tx_hash));
            self
        }

        fn deposit_from(
            mut self,
            user_address: Felt,
            amount: u64,
            block: u64,
            tx_hash: Felt,
        ) -> Self {
            self.events
                .push(deposit_event_from(user_address, amount, block, tx_hash));
            self
        }

        fn pubkey(mut self, user_address: Felt, pubkey: Felt, block: u64, tx_hash: Felt) -> Self {
            self.storage
                .insert_with_block(storage_slots::public_key(user_address), pubkey, block);
            self.events
                .push(viewing_key_set_event(user_address, pubkey, block, tx_hash));
            self
        }

        fn withdrawal(mut self, amount: u64, block: u64, tx_hash: Felt) -> Self {
            self.events.push(withdrawal_event(amount, block, tx_hash));
            self
        }

        fn build(self, last_index: Option<u64>) -> (MockHistoryBackend, HistoryCursor) {
            let backend = MockHistoryBackend {
                storage: self.storage,
                events: MockEventBackend::new(self.events),
            };
            let cursor = HistoryCursor {
                subchannels: vec![HistorySubchannel {
                    channel_key: self.key,
                    token: TOKEN,
                    channel_kind: ChannelKind::Incoming,
                    counterparty: Felt::from_hex_unchecked("0xBEEF"),
                    next_index: last_index,
                }],
                begin_block_number: Some(100),
                history_complete: false,
            };
            (backend, cursor)
        }
    }

    // -- fetch_aggregated_block_events tests --

    #[tokio::test]
    async fn block_events_matches_notes() {
        let events = vec![
            enc_note_created_event(NOTE_ID, 10, TX_HASH_1),
            deposit_event(100, 10, TX_HASH_1),
        ];
        let backend = MockEventBackend::new(events);
        let budget = IoBudget::new(100);
        let mut transactions = HashMap::new();

        fetch_aggregated_block_events(
            &backend,
            ADDRESS,
            10,
            vec![test_note(NOTE_ID)],
            &budget,
            &mut transactions,
        )
        .await
        .unwrap();

        assert_eq!(transactions.len(), 1);
        let tx = &transactions[&TX_HASH_1];
        assert_eq!(tx.notes.len(), 1);
        assert_eq!(tx.deposits.len(), 1);
        assert_eq!(tx.deposits[0].amount, 100);
    }

    #[tokio::test]
    async fn block_events_skips_unmatched_auxiliary_events() {
        let events = vec![deposit_event(100, 10, TX_HASH_1)];
        let backend = MockEventBackend::new(events);
        let budget = IoBudget::new(100);
        let mut transactions = HashMap::new();

        fetch_aggregated_block_events(&backend, ADDRESS, 10, vec![], &budget, &mut transactions)
            .await
            .unwrap();

        assert!(transactions.is_empty());
    }

    #[tokio::test]
    async fn block_events_zero_budget() {
        let backend = MockEventBackend::empty();
        let budget = IoBudget::new(0);
        let mut transactions = HashMap::new();

        let error = fetch_aggregated_block_events(
            &backend,
            ADDRESS,
            10,
            vec![],
            &budget,
            &mut transactions,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(error, DiscoveryError::InsufficientBudget { .. }),
            "expected InsufficientBudget, got: {error:?}"
        );
        assert!(transactions.is_empty());
    }

    #[tokio::test]
    async fn block_events_skips_deposit_in_different_transaction() {
        let events = vec![
            enc_note_created_event(NOTE_ID, 10, TX_HASH_1),
            deposit_event(100, 10, TX_HASH_2),
        ];
        let backend = MockEventBackend::new(events);
        let budget = IoBudget::new(100);
        let mut transactions = HashMap::new();

        fetch_aggregated_block_events(
            &backend,
            ADDRESS,
            10,
            vec![test_note(NOTE_ID)],
            &budget,
            &mut transactions,
        )
        .await
        .unwrap();

        assert_eq!(transactions.len(), 1);
        let tx = &transactions[&TX_HASH_1];
        assert_eq!(tx.notes.len(), 1);
        assert!(tx.deposits.is_empty());
        assert!(!transactions.contains_key(&TX_HASH_2));
    }

    #[tokio::test]
    async fn block_events_multiple_notes_multiple_transactions() {
        const NOTE_ID_2: Felt = Felt::from_hex_unchecked("0xAACC");

        let events = vec![
            enc_note_created_event(NOTE_ID, 10, TX_HASH_1),
            deposit_event(100, 10, TX_HASH_1),
            enc_note_created_event(NOTE_ID_2, 10, TX_HASH_2),
            withdrawal_event(50, 10, TX_HASH_2),
        ];
        let backend = MockEventBackend::new(events);
        let budget = IoBudget::new(100);
        let mut transactions = HashMap::new();

        fetch_aggregated_block_events(
            &backend,
            ADDRESS,
            10,
            vec![test_note(NOTE_ID), test_note(NOTE_ID_2)],
            &budget,
            &mut transactions,
        )
        .await
        .unwrap();

        assert_eq!(transactions.len(), 2);

        let tx1 = &transactions[&TX_HASH_1];
        assert_eq!(tx1.notes.len(), 1);
        assert_eq!(tx1.deposits.len(), 1);
        assert!(tx1.withdrawals.is_empty());

        let tx2 = &transactions[&TX_HASH_2];
        assert_eq!(tx2.notes.len(), 1);
        assert_eq!(tx2.withdrawals.len(), 1);
        assert!(tx2.deposits.is_empty());
    }

    #[tokio::test]
    async fn block_events_unmatched_note_creates_no_transaction() {
        let unmatched_note_id = Felt::from_hex_unchecked("0x9999");
        let events = vec![
            enc_note_created_event(NOTE_ID, 10, TX_HASH_1),
            deposit_event(100, 10, TX_HASH_1),
        ];
        let backend = MockEventBackend::new(events);
        let budget = IoBudget::new(100);
        let mut transactions = HashMap::new();

        fetch_aggregated_block_events(
            &backend,
            ADDRESS,
            10,
            vec![test_note(unmatched_note_id)],
            &budget,
            &mut transactions,
        )
        .await
        .unwrap();

        assert!(transactions.is_empty());
    }

    #[tokio::test]
    async fn block_events_filters_deposit_by_address() {
        let events = vec![
            enc_note_created_event(NOTE_ID, 10, TX_HASH_1),
            deposit_event(100, 10, TX_HASH_1),
            deposit_event_from(OTHER_ADDRESS, 200, 10, TX_HASH_1),
        ];
        let backend = MockEventBackend::new(events);
        let budget = IoBudget::new(100);
        let mut transactions = HashMap::new();

        fetch_aggregated_block_events(
            &backend,
            ADDRESS,
            10,
            vec![test_note(NOTE_ID)],
            &budget,
            &mut transactions,
        )
        .await
        .unwrap();

        assert_eq!(transactions.len(), 1);
        let tx = &transactions[&TX_HASH_1];
        assert_eq!(tx.deposits.len(), 1);
        assert_eq!(tx.deposits[0].amount, 100);
        assert_eq!(tx.deposits[0].user_address, ADDRESS);
    }

    #[tokio::test]
    async fn block_events_excludes_all_foreign_deposits() {
        let events = vec![
            enc_note_created_event(NOTE_ID, 10, TX_HASH_1),
            deposit_event_from(OTHER_ADDRESS, 200, 10, TX_HASH_1),
        ];
        let backend = MockEventBackend::new(events);
        let budget = IoBudget::new(100);
        let mut transactions = HashMap::new();

        fetch_aggregated_block_events(
            &backend,
            ADDRESS,
            10,
            vec![test_note(NOTE_ID)],
            &budget,
            &mut transactions,
        )
        .await
        .unwrap();

        assert_eq!(transactions.len(), 1);
        let tx = &transactions[&TX_HASH_1];
        assert!(tx.deposits.is_empty());
        assert_eq!(tx.notes.len(), 1);
    }

    // -- fetch_gap_withdrawals_chunked tests --

    #[tokio::test]
    async fn gap_withdrawals_group_by_tx_hash() {
        let events = vec![
            withdrawal_event(50, 15, TX_HASH_1),
            withdrawal_event(50, 20, TX_HASH_2),
        ];
        let backend = MockEventBackend::new(events);
        let budget = IoBudget::new(100);
        let mut transactions = HashMap::new();

        let window_bottom = fetch_gap_withdrawals_chunked(
            &backend,
            ADDRESS,
            10,
            25,
            BlockId::Number(25),
            &budget,
            &mut transactions,
        )
        .await
        .unwrap();

        // The whole 16-block gap fits in one chunk → fully scanned to the floor.
        assert_eq!(window_bottom, 10);
        assert_eq!(transactions.len(), 2);
    }

    #[tokio::test]
    async fn gap_withdrawals_no_matches() {
        let backend = MockEventBackend::empty();
        let budget = IoBudget::new(100);
        let mut transactions = HashMap::new();

        let window_bottom = fetch_gap_withdrawals_chunked(
            &backend,
            ADDRESS,
            10,
            25,
            BlockId::Number(25),
            &budget,
            &mut transactions,
        )
        .await
        .unwrap();

        assert_eq!(window_bottom, 10);
        assert!(transactions.is_empty());
    }

    #[tokio::test]
    async fn gap_withdrawals_zero_budget() {
        let backend = MockEventBackend::empty();
        let budget = IoBudget::new(0);
        let mut transactions = HashMap::new();

        let error = fetch_gap_withdrawals_chunked(
            &backend,
            ADDRESS,
            10,
            25,
            BlockId::Number(25),
            &budget,
            &mut transactions,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(error, DiscoveryError::InsufficientBudget { .. }),
            "expected InsufficientBudget, got: {error:?}"
        );
        assert!(transactions.is_empty());
    }

    #[tokio::test]
    async fn gap_withdrawals_chunks_within_budget() {
        // Gap [0, 1024] = 1025 blocks → 2 chunks needed (cost 20).
        let backend = MockEventBackend::empty();

        // Full budget for both chunks → whole gap covered in one call.
        let budget = IoBudget::new(COST_EVENTS_CHUNK * 2);
        let window_bottom = fetch_gap_withdrawals_chunked(
            &backend,
            ADDRESS,
            0,
            1024,
            BlockId::Number(1024),
            &budget,
            &mut HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(window_bottom, 0, "full gap covered down to the floor");
        assert_eq!(budget.remaining(), 0);

        // Budget for only one chunk → the top [1, 1024] window is scanned and
        // the floor (block 0) is left for the next page. This is the key
        // behavior change: a tight budget makes *partial progress* instead of
        // erroring.
        let budget = IoBudget::new(COST_EVENTS_CHUNK);
        let window_bottom = fetch_gap_withdrawals_chunked(
            &backend,
            ADDRESS,
            0,
            1024,
            BlockId::Number(1024),
            &budget,
            &mut HashMap::new(),
        )
        .await
        .unwrap();
        assert_eq!(window_bottom, 1, "only the top 1024-block chunk scanned");
        assert_eq!(budget.remaining(), 0);

        // Not even one chunk affordable → error (no forward progress possible).
        let budget = IoBudget::new(COST_EVENTS_CHUNK - 1);
        let error = fetch_gap_withdrawals_chunked(
            &backend,
            ADDRESS,
            0,
            1024,
            BlockId::Number(1024),
            &budget,
            &mut HashMap::new(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(error, DiscoveryError::InsufficientBudget { .. }),
            "expected InsufficientBudget, got: {error:?}"
        );
    }

    #[tokio::test]
    async fn fetch_transactions_skips_notes_above_cursor_upper_bound() {
        // Regression: stale/malicious cursor with begin_block_number below the
        // scanner's first emitted note block used to trigger a u64 underflow
        // in the withdrawal-event cost calc, producing `needed ≈ 1.8e17`.
        // Now such notes are skipped silently.
        let (backend, mut cursor) = FixtureBuilder::new()
            .note(0, 100, TX_HASH_1)
            .deposit(50, 100, TX_HASH_1)
            .build(Some(0));
        cursor.begin_block_number = Some(10); // below the note's block (100)

        let budget = IoBudget::new(1_000);
        let result = fetch_transactions(&backend, ADDRESS, &mut cursor, 10, &budget)
            .await
            .unwrap();

        assert!(result.is_empty(), "note above upper bound must be skipped");
        assert!(cursor.history_complete);
    }

    // -- fetch_transactions tests --

    #[tokio::test]
    async fn empty_scan() {
        let backend = MockHistoryBackend {
            storage: MockBackend::empty(),
            events: MockEventBackend::empty(),
        };
        let mut cursor = HistoryCursor {
            subchannels: vec![],
            begin_block_number: Some(100),
            history_complete: false,
        };

        let result = fetch_transactions(&backend, ADDRESS, &mut cursor, 10, &IoBudget::new(1000))
            .await
            .unwrap();

        assert!(result.is_empty());
        assert!(cursor.history_complete);
    }

    #[tokio::test]
    async fn single_block_with_deposit() {
        let (backend, mut cursor) = FixtureBuilder::new()
            .note(0, 10, TX_HASH_1)
            .deposit(100, 10, TX_HASH_1)
            .build(Some(0));

        let result = fetch_transactions(&backend, ADDRESS, &mut cursor, 10, &IoBudget::new(1000))
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].block_number, 10);
        assert_eq!(result[0].notes.len(), 1);
        assert_eq!(result[0].deposits.len(), 1);
        assert_eq!(result[0].deposits[0].amount, 100);
    }

    #[tokio::test]
    async fn multiple_blocks_sorted_descending() {
        let (backend, mut cursor) = FixtureBuilder::new()
            .note(0, 10, TX_HASH_1)
            .note(1, 20, TX_HASH_2)
            .deposit(100, 10, TX_HASH_1)
            .withdrawal(50, 20, TX_HASH_2)
            .build(Some(1));

        let result = fetch_transactions(&backend, ADDRESS, &mut cursor, 10, &IoBudget::new(1000))
            .await
            .unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].block_number, 20);
        assert_eq!(result[0].notes.len(), 1);
        assert_eq!(result[0].withdrawals.len(), 1);
        assert_eq!(result[1].block_number, 10);
        assert_eq!(result[1].notes.len(), 1);
        assert_eq!(result[1].deposits.len(), 1);
    }

    #[tokio::test]
    async fn zero_budget_returns_insufficient_budget_error() {
        let (backend, mut cursor) = FixtureBuilder::new().note(0, 10, TX_HASH_1).build(Some(0));

        let error = fetch_transactions(&backend, ADDRESS, &mut cursor, 10, &IoBudget::new(0))
            .await
            .unwrap_err();

        assert!(
            matches!(error, DiscoveryError::InsufficientBudget { .. }),
            "expected InsufficientBudget, got: {error:?}"
        );
    }

    #[tokio::test]
    async fn budget_limits_to_one_block() {
        let (backend, mut cursor) = FixtureBuilder::new()
            .note(0, 10, TX_HASH_1)
            .note(1, 20, TX_HASH_2)
            .build(Some(1));

        // Budget for one complete block iteration:
        // fill_buffers (2 reads: initial + refill) + block events + withdrawal range
        let one_block_budget = 2 * COST_NOTE + COST_BLOCK_EVENTS_QUERY + COST_EVENTS_CHUNK;
        let result = fetch_transactions(
            &backend,
            ADDRESS,
            &mut cursor,
            10,
            &IoBudget::new(one_block_budget),
        )
        .await
        .unwrap();

        assert!(!result.is_empty());
        assert!(!cursor.history_complete);
    }

    #[tokio::test]
    async fn gap_withdrawal_kept_on_early_break() {
        // Regression: the iteration-1 gap fetch covers `[K_max + 1, tip]` and
        // successfully picks up withdrawals above the highest note block. When
        // budget runs out mid-iteration-2, those gap-range transactions must
        // still be returned — dropping them leaves subsequent pages with no
        // way to re-fetch that range (later gaps cover `[K_i+1, K_{i-1}]`,
        // strictly below `K_max`).
        const TX_HASH_3: Felt = Felt::from_hex_unchecked("0x1003");

        let (backend, mut cursor) = FixtureBuilder::new()
            .note(0, 10, TX_HASH_1)
            .note(1, 20, TX_HASH_2)
            .deposit(100, 20, TX_HASH_2)
            .withdrawal(50, 50, TX_HASH_3)
            .build(Some(1));

        // Budget for one complete block iteration:
        // fill_buffers (2 reads: initial + refill) + block events + withdrawal range
        let one_block_budget = 2 * COST_NOTE + COST_BLOCK_EVENTS_QUERY + COST_EVENTS_CHUNK;
        let result = fetch_transactions(
            &backend,
            ADDRESS,
            &mut cursor,
            10,
            &IoBudget::new(one_block_budget),
        )
        .await
        .unwrap();

        // Block 20 tx AND the gap-range withdrawal at block 50 are both
        // kept; block-10 iteration didn't complete so any orphan from it is
        // dropped.
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].block_number, 50);
        assert_eq!(result[0].transaction_hash, TX_HASH_3);
        assert_eq!(result[0].withdrawals.len(), 1);
        assert_eq!(result[0].withdrawals[0].amount, 50);
        assert!(result[0].notes.is_empty());
        assert_eq!(result[1].block_number, 20);
        assert_eq!(result[1].notes.len(), 1);
        assert_eq!(result[1].deposits.len(), 1);
        assert!(!cursor.history_complete);
    }

    #[tokio::test]
    async fn far_behind_account_paginates_instead_of_500() {
        // Regression: an account whose most-recent note sits ~1M blocks below
        // the upper bound used to charge the whole gap as one indivisible cost
        // that exceeded the per-request budget, returning InsufficientBudget
        // (HTTP 500) with no forward progress. The gap is now scanned in
        // budget-bounded windows, so each page returns 200 and advances the
        // cursor until the gap is covered.
        const TX_HASH_W: Felt = Felt::from_hex_unchecked("0x1009");

        let (backend, mut cursor) = FixtureBuilder::new()
            .note(0, 100, TX_HASH_1)
            .withdrawal(50, 150, TX_HASH_W)
            .build(Some(0));
        cursor.begin_block_number = Some(1_100_000); // ~1.1M-block gap above the note

        // Page 1: only the most-recent window is scanned (empty here); the call
        // succeeds where it previously 500'd, and the cursor advances downward.
        let page1 = fetch_transactions(&backend, ADDRESS, &mut cursor, 10, &IoBudget::new(10_000))
            .await
            .expect("wide gap must paginate, not return InsufficientBudget");
        assert!(page1.is_empty(), "no withdrawals in the most-recent window");
        assert!(!cursor.history_complete);
        assert!(
            cursor.begin_block_number.unwrap() < 1_100_000,
            "cursor must advance downward"
        );

        // Page 2: the remainder of the gap is covered, surfacing the withdrawal
        // and the note, and the scan completes.
        let page2 = fetch_transactions(&backend, ADDRESS, &mut cursor, 10, &IoBudget::new(10_000))
            .await
            .unwrap();
        let blocks: Vec<u64> = page2.iter().map(|tx| tx.block_number).collect();
        assert!(
            blocks.contains(&150),
            "withdrawal block surfaced: {blocks:?}"
        );
        assert!(blocks.contains(&100), "note block surfaced: {blocks:?}");
        let withdrawal_tx = page2.iter().find(|tx| tx.block_number == 150).unwrap();
        assert_eq!(withdrawal_tx.withdrawals.len(), 1);
        assert_eq!(withdrawal_tx.withdrawals[0].amount, 50);
        assert!(cursor.history_complete);
    }

    #[tokio::test]
    async fn note_block_withdrawal_not_double_counted_across_pages() {
        // A partial withdrawal emits a note and a Withdrawal in the same block.
        // Gap windows are strictly *above* each note block, so block 20's
        // withdrawal is attached once (via block events) and is never re-scanned
        // by a later page's gap. Drive two pages and assert it appears once.
        let (backend, mut cursor) = FixtureBuilder::new()
            .note(0, 10, TX_HASH_1)
            .note(1, 20, TX_HASH_2)
            .withdrawal(50, 20, TX_HASH_2) // same block & tx as note 1
            .build(Some(1));

        // Page 1: budget for the block-20 iteration only.
        let one_block_budget = 2 * COST_NOTE + COST_BLOCK_EVENTS_QUERY + COST_EVENTS_CHUNK;
        let page1 = fetch_transactions(
            &backend,
            ADDRESS,
            &mut cursor,
            1,
            &IoBudget::new(one_block_budget),
        )
        .await
        .unwrap();
        // Page 2: the remainder.
        let page2 = fetch_transactions(&backend, ADDRESS, &mut cursor, 10, &IoBudget::new(1000))
            .await
            .unwrap();

        let total_withdrawals = page1
            .iter()
            .chain(page2.iter())
            .flat_map(|tx| tx.withdrawals.iter())
            .filter(|withdrawal| withdrawal.amount == 50)
            .count();
        assert_eq!(
            total_withdrawals, 1,
            "block-20 withdrawal counted exactly once"
        );
    }

    #[tokio::test]
    async fn foreign_deposit_excluded_in_full_scan() {
        let (backend, mut cursor) = FixtureBuilder::new()
            .note(0, 10, TX_HASH_1)
            .deposit(100, 10, TX_HASH_1)
            .deposit_from(OTHER_ADDRESS, 200, 10, TX_HASH_1)
            .build(Some(0));

        let result = fetch_transactions(&backend, ADDRESS, &mut cursor, 10, &IoBudget::new(1000))
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].deposits.len(), 1);
        assert_eq!(result[0].deposits[0].amount, 100);
        assert_eq!(result[0].deposits[0].user_address, ADDRESS);
    }

    #[tokio::test]
    async fn cursor_state_after_full_scan() {
        let (backend, mut cursor) = FixtureBuilder::new().note(0, 10, TX_HASH_1).build(Some(0));
        assert_eq!(cursor.begin_block_number, Some(100));

        fetch_transactions(&backend, ADDRESS, &mut cursor, 10, &IoBudget::new(1000))
            .await
            .unwrap();

        assert_eq!(cursor.begin_block_number, Some(9));
        assert!(cursor.history_complete);
    }

    // -- registration event tests --

    const PUBKEY: Felt = Felt::from_hex_unchecked("0xBEE1");

    #[tokio::test]
    async fn registration_appended_on_complete_scan() {
        let (backend, mut cursor) = FixtureBuilder::new()
            .note(0, 10, TX_HASH_1)
            .pubkey(ADDRESS, PUBKEY, 5, TX_HASH_REG)
            .build(Some(0));

        let result = fetch_transactions(&backend, ADDRESS, &mut cursor, 10, &IoBudget::new(1000))
            .await
            .unwrap();

        assert_eq!(result.len(), 2);
        assert!(cursor.history_complete);

        let registration = &result[1];
        assert_eq!(registration.registered_pubkey, Some(PUBKEY));
        assert_eq!(registration.block_number, 5);
        assert_eq!(registration.transaction_hash, TX_HASH_REG);
        assert!(registration.notes.is_empty());
        assert!(registration.deposits.is_empty());
        assert!(registration.withdrawals.is_empty());
        assert!(registration.open_note_deposits.is_empty());
    }

    #[tokio::test]
    async fn registration_not_appended_on_partial_scan() {
        let (backend, mut cursor) = FixtureBuilder::new()
            .note(0, 10, TX_HASH_1)
            .note(1, 20, TX_HASH_2)
            .pubkey(ADDRESS, PUBKEY, 5, TX_HASH_REG)
            .build(Some(1));

        let one_block_budget = 2 * COST_NOTE + COST_BLOCK_EVENTS_QUERY + COST_EVENTS_CHUNK;
        let result = fetch_transactions(
            &backend,
            ADDRESS,
            &mut cursor,
            10,
            &IoBudget::new(one_block_budget),
        )
        .await
        .unwrap();

        assert!(!cursor.history_complete);
        assert!(result.iter().all(|tx| tx.registered_pubkey.is_none()));
    }

    #[tokio::test]
    async fn registration_deferred_when_page_full() {
        let (backend, mut cursor) = FixtureBuilder::new()
            .note(0, 10, TX_HASH_1)
            .pubkey(ADDRESS, PUBKEY, 5, TX_HASH_REG)
            .build(Some(0));

        // First page: max_transactions=1, note tx fills the page.
        let result = fetch_transactions(&backend, ADDRESS, &mut cursor, 1, &IoBudget::new(1000))
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        assert!(result[0].registered_pubkey.is_none());
        assert!(!cursor.history_complete);

        // Second page: scanner is already exhausted, only registration returned.
        let result = fetch_transactions(&backend, ADDRESS, &mut cursor, 1, &IoBudget::new(1000))
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].registered_pubkey, Some(PUBKEY));
        assert!(cursor.history_complete);
    }

    #[tokio::test]
    async fn registration_sorted_last() {
        let (backend, mut cursor) = FixtureBuilder::new()
            .note(0, 10, TX_HASH_1)
            .note(1, 20, TX_HASH_2)
            .pubkey(ADDRESS, PUBKEY, 5, TX_HASH_REG)
            .build(Some(1));

        let result = fetch_transactions(&backend, ADDRESS, &mut cursor, 10, &IoBudget::new(1000))
            .await
            .unwrap();

        assert_eq!(result.len(), 3);
        assert_eq!(result[0].block_number, 20);
        assert!(result[0].registered_pubkey.is_none());
        assert_eq!(result[1].block_number, 10);
        assert!(result[1].registered_pubkey.is_none());
        assert_eq!(result[2].block_number, 5);
        assert_eq!(result[2].registered_pubkey, Some(PUBKEY));
    }
}
