//! Coordinated backward history scan.
//!
//! Orchestrates note reading, block event fetching, and withdrawal event
//! fetching, then merges results into a unified transaction list.

use std::collections::{HashMap, HashSet};

use starknet_types_core::felt::Felt;
use tracing::{debug, trace};

use super::notes::BufferedNoteScanner;
use super::types::{HistoryCursor, HistoryNote, HistoryTransaction};
use crate::discovery::{
    DiscoveryError, COST_BLOCK_EVENTS_QUERY, COST_EVENTS_CHUNK, COST_PUBLIC_KEY,
    EVENTS_COST_CHUNK_SIZE,
};
use crate::io_budget::IoBudget;
use crate::privacy_pool::events::{IEvents, PrivacyPoolEventContent};
use crate::privacy_pool::views::IViews;

/// Fetches history transactions by coordinating note reads and event fetches.
///
/// Each loop iteration:
/// 1. Drain the next block of notes via [`BufferedNoteScanner::next_block`].
/// 2. Fetch block events and group into transactions via [`fetch_aggregated_block_events`].
/// 3. Fetch withdrawal events for the gap range via [`fetch_aggregated_withdrawal_events`].
///
/// Budget is consumed incrementally; exits early if insufficient.
/// Returns transactions sorted by `block_number` descending.
pub async fn fetch_transactions<B: IViews + IEvents>(
    backend: &B,
    user_address: Felt,
    cursor: &mut HistoryCursor,
    max_transactions: usize,
    budget: &IoBudget,
) -> Result<Vec<HistoryTransaction>, DiscoveryError> {
    debug!(
        num_subchannels = cursor.subchannels.len(),
        begin_block_number = cursor.begin_block_number,
        budget_remaining = budget.remaining(),
        max_transactions,
        "history: starting fetch_transactions"
    );

    let mut note_scanner = BufferedNoteScanner::new();
    let mut transactions: HashMap<Felt, HistoryTransaction> = HashMap::new();
    let mut completed_blocks: HashSet<u64> = HashSet::new();
    let mut previous_block_bound = cursor.begin_block_number;
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
            budget,
            previous_block_bound,
            &mut transactions,
        )
        .await
        {
            Ok(Some(block_number)) => {
                completed_blocks.insert(block_number);
                previous_block_bound = block_number.saturating_sub(1);
            }
            Ok(None) => {
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

    cursor.begin_block_number = previous_block_bound;

    let mut result: Vec<HistoryTransaction> = transactions.into_values().collect();
    if !scanner_complete {
        result.retain(|tx| completed_blocks.contains(&tx.block_number));
    }

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

    result.sort_by(|a, b| b.block_number.cmp(&a.block_number));

    debug!(
        num_transactions = result.len(),
        history_complete = cursor.history_complete,
        budget_remaining = budget.remaining(),
        begin_block_number = cursor.begin_block_number,
        "history: fetch_transactions done"
    );

    if result.is_empty() {
        if let Some(error) = budget_error {
            return Err(error);
        }
    }

    Ok(result)
}

/// Processes one block: drains notes, fetches block events, fetches gap withdrawals.
///
/// Returns `Ok(Some(block_number))` on success, `Ok(None)` when the scanner is exhausted.
/// `InsufficientBudget` propagates via `?`.
async fn process_next_block<B: IViews + IEvents>(
    backend: &B,
    user_address: Felt,
    note_scanner: &mut BufferedNoteScanner,
    cursor: &mut HistoryCursor,
    budget: &IoBudget,
    previous_block_bound: u64,
    transactions: &mut HashMap<Felt, HistoryTransaction>,
) -> Result<Option<u64>, DiscoveryError> {
    let Some((block_number, block_notes)) =
        note_scanner.next_block(backend, cursor, budget).await?
    else {
        return Ok(None);
    };

    trace!(
        block_number,
        num_notes = block_notes.len(),
        budget_remaining = budget.remaining(),
        "history: processing block"
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

    let withdrawal_range_start = block_number + 1;
    if withdrawal_range_start <= previous_block_bound {
        fetch_aggregated_withdrawal_events(
            backend,
            user_address,
            withdrawal_range_start,
            previous_block_bound,
            budget,
            transactions,
        )
        .await?;
    }

    Ok(Some(block_number))
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

    let block_events = backend.get_block_events(block_number).await?;

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

/// Fetches withdrawal events for a block range and groups them into `transactions`.
///
/// These are standalone withdrawals (in the gap between note blocks) filtered
/// by `user_address` at the RPC level (`get_withdrawal_events`). Note that the same
/// withdrawal-attribution caveats from [`fetch_aggregated_block_events`] apply
/// to in-block withdrawals but **not** here, since gap-range withdrawals are
/// already keyed on the querying account's address.
///
/// Budget cost scales with the range size:
/// `ceil(num_blocks / EVENTS_COST_CHUNK_SIZE) * COST_EVENTS_CHUNK`.
///
/// Returns `Err(InsufficientBudget)` if budget is insufficient (no work done).
async fn fetch_aggregated_withdrawal_events<E: IEvents>(
    backend: &E,
    user_address: Felt,
    from_block: u64,
    to_block: u64,
    budget: &IoBudget,
    transactions: &mut HashMap<Felt, HistoryTransaction>,
) -> Result<(), DiscoveryError> {
    let num_blocks = (to_block - from_block + 1) as usize;
    let num_queries = num_blocks.div_ceil(EVENTS_COST_CHUNK_SIZE);
    let cost = num_queries * COST_EVENTS_CHUNK;

    budget.try_consume(cost)?;

    let events = backend
        .get_withdrawal_events(user_address, from_block, to_block)
        .await?;

    trace!(
        from_block,
        to_block,
        num_blocks,
        num_withdrawal_events = events.len(),
        "withdrawal_events: fetched"
    );

    for event in events {
        let tx = transactions
            .entry(event.transaction_hash)
            .or_insert_with(|| HistoryTransaction::new(event.block_number, event.transaction_hash));
        if let PrivacyPoolEventContent::Withdrawal(withdrawal) = event.content {
            tx.withdrawals.push(withdrawal);
        }
    }

    Ok(())
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
    let block = storage_result.last_update_block;

    budget.try_consume(COST_EVENTS_CHUNK)?;
    let events = backend
        .get_viewing_key_set_events(user_address, block, block)
        .await?;
    let transaction_hash = events
        .first()
        .map(|event| event.transaction_hash)
        .ok_or_else(|| {
            DiscoveryError::EventError(format!(
                "ViewingKeySet event not found at block {block} for user {user_address:#x}"
            ))
        })?;

    let mut registration = HistoryTransaction::new(block, transaction_hash);
    registration.registered_pubkey = Some(storage_result.value);
    Ok(Some(registration))
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
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
            from_block: u64,
            to_block: u64,
        ) -> Result<Vec<EmittedEvent>, StorageError> {
            self.events.get_events(keys, from_block, to_block).await
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
                begin_block_number: 100,
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

    // -- fetch_aggregated_withdrawal_events tests --

    #[tokio::test]
    async fn withdrawal_events_groups_by_tx_hash() {
        let events = vec![
            withdrawal_event(50, 15, TX_HASH_1),
            withdrawal_event(50, 20, TX_HASH_2),
        ];
        let backend = MockEventBackend::new(events);
        let budget = IoBudget::new(100);
        let mut transactions = HashMap::new();

        fetch_aggregated_withdrawal_events(&backend, ADDRESS, 10, 25, &budget, &mut transactions)
            .await
            .unwrap();

        assert_eq!(transactions.len(), 2);
    }

    #[tokio::test]
    async fn withdrawal_events_empty_range() {
        let backend = MockEventBackend::empty();
        let budget = IoBudget::new(100);
        let mut transactions = HashMap::new();

        fetch_aggregated_withdrawal_events(&backend, ADDRESS, 10, 25, &budget, &mut transactions)
            .await
            .unwrap();

        assert!(transactions.is_empty());
    }

    #[tokio::test]
    async fn withdrawal_events_zero_budget() {
        let backend = MockEventBackend::empty();
        let budget = IoBudget::new(0);
        let mut transactions = HashMap::new();

        let error = fetch_aggregated_withdrawal_events(
            &backend,
            ADDRESS,
            10,
            25,
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

    // -- fetch_transactions tests --

    #[tokio::test]
    async fn empty_scan() {
        let backend = MockHistoryBackend {
            storage: MockBackend::empty(),
            events: MockEventBackend::empty(),
        };
        let mut cursor = HistoryCursor {
            subchannels: vec![],
            begin_block_number: 100,
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
    async fn gap_withdrawal_filtered_on_early_break() {
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

        // Block 20 tx kept, gap-range withdrawal at block 50 filtered out
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].block_number, 20);
        assert!(!cursor.history_complete);
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
        assert_eq!(cursor.begin_block_number, 100);

        fetch_transactions(&backend, ADDRESS, &mut cursor, 10, &IoBudget::new(1000))
            .await
            .unwrap();

        assert_eq!(cursor.begin_block_number, 9);
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
