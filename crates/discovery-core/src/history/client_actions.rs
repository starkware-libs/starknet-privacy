//! Client action reconstruction from aggregated note events.
//!
//! Two-pass pipeline:
//! 1. **Reconstruct** (pure): classify note events per block into [`ClientAction`]s using
//!    note creation events and on-chain deposit/withdrawal events.
//! 2. **Enrich** (async, TODO): for `SwapIn` actions, look up `OpenNoteDeposited` events to
//!    identify the swap counterparty and create `SwapOut`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

use super::onchain_events::BlockOnChainEvents;
use super::types::{ChannelKind, CreateNoteEvent, HistoryEvent};
use crate::discovery::DiscoveryError;
use crate::privacy_pool::events::{IEvents, PrivacyPoolEventContent};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientActionKind {
    /// `from_address` is populated from the on-chain Deposit event.
    Deposit {
        from_address: Option<Felt>,
    },
    TransferSent {
        recipient: Felt,
    },
    TransferReceived {
        sender: Felt,
    },
    /// `to_address` is populated from the on-chain Withdrawal event.
    Withdrawal {
        to_address: Option<Felt>,
    },
    /// Swap input: an open note was created (part of a swap operation).
    SwapIn,
    /// Swap output: a withdrawal that co-occurs with a `SwapIn` in the same block.
    /// `to_address` is populated from the on-chain Withdrawal event.
    /// TODO: after enrichment via `OpenNoteDeposited`, confirm depositor == to_address.
    SwapOut {
        to_address: Option<Felt>,
    },
    /// Self-channel notes were found but no matching on-chain deposit or withdrawal event
    /// exists for this block and token. This can happen when the user's transaction doesn't
    /// emit standard Deposit/Withdrawal events, or when the on-chain event fetch is incomplete.
    ///
    /// TODO: once a `NoteCreated` event exists in the contract, fetch it by `note_id` for all
    /// blocks with self notes → get `tx_hash` → fetch all events in that tx to discover
    /// deposits/withdrawals to different addresses.
    Unknown,
}

/// One reconstructed action per block+token, with all underlying events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientAction {
    pub block_number: u64,
    pub action_kind: ClientActionKind,
    pub token: Felt,
    pub amount: u128,
    pub events: Vec<HistoryEvent>,
}

/// Reconstructs client actions from note events and on-chain events grouped by block number.
///
/// Actions are returned grouped by block number in ascending order. Each block is processed
/// per-token, and a single block+token may produce multiple actions (e.g. TransferSent + Deposit).
pub fn reconstruct_client_actions(
    events_by_block: &BTreeMap<u64, Vec<CreateNoteEvent>>,
    on_chain_events: &BTreeMap<u64, BlockOnChainEvents>,
) -> BTreeMap<u64, Vec<ClientAction>> {
    let mut actions_by_block: BTreeMap<u64, Vec<ClientAction>> = BTreeMap::new();
    for (&block_number, events) in events_by_block {
        let block_on_chain = on_chain_events.get(&block_number);
        let mut block_actions = Vec::new();
        classify_block_events(block_number, events, block_on_chain, &mut block_actions);
        if !block_actions.is_empty() {
            actions_by_block.insert(block_number, block_actions);
        }
    }
    actions_by_block
}

fn classify_block_events(
    block_number: u64,
    events: &[CreateNoteEvent],
    block_on_chain: Option<&BlockOnChainEvents>,
    actions: &mut Vec<ClientAction>,
) {
    let start = actions.len();
    let mut by_token: BTreeMap<Felt, Vec<CreateNoteEvent>> = BTreeMap::new();
    for event in events {
        by_token.entry(event.token).or_default().push(event.clone());
    }
    for (token, token_events) in by_token {
        classify_token_events(block_number, token, &token_events, block_on_chain, actions);
    }
    promote_withdrawals_to_swap_out(&mut actions[start..]);
}

/// If any `SwapIn` action exists in the block, promote all `Withdrawal` actions to `SwapOut`.
fn promote_withdrawals_to_swap_out(block_actions: &mut [ClientAction]) {
    let has_swap_in = block_actions
        .iter()
        .any(|a| a.action_kind == ClientActionKind::SwapIn);
    if !has_swap_in {
        return;
    }
    for action in block_actions.iter_mut() {
        if let ClientActionKind::Withdrawal { to_address } = action.action_kind {
            action.action_kind = ClientActionKind::SwapOut { to_address };
        }
    }
}

fn classify_token_events(
    block_number: u64,
    token: Felt,
    events: &[CreateNoteEvent],
    block_on_chain: Option<&BlockOnChainEvents>,
    actions: &mut Vec<ClientAction>,
) {
    let mut incoming_by_sender: BTreeMap<Felt, Vec<CreateNoteEvent>> = BTreeMap::new();
    let mut outgoing_by_recipient: BTreeMap<Felt, Vec<CreateNoteEvent>> = BTreeMap::new();
    let mut open_note_events = Vec::new();
    let mut self_channel_events = Vec::new();

    for event in events {
        if event.is_open && event.channel_kind == ChannelKind::SelfChannel {
            open_note_events.push(event.clone());
            continue;
        }

        match event.channel_kind {
            ChannelKind::Incoming => {
                incoming_by_sender
                    .entry(event.counterparty)
                    .or_default()
                    .push(event.clone());
            }
            ChannelKind::Outgoing => {
                outgoing_by_recipient
                    .entry(event.counterparty)
                    .or_default()
                    .push(event.clone());
            }
            ChannelKind::SelfChannel => {
                self_channel_events.push(event.clone());
            }
        }
    }

    // Incoming Created → TransferReceived (grouped by sender)
    for (sender, sender_events) in incoming_by_sender {
        let amount = sender_events
            .iter()
            .map(|e| e.amount)
            .fold(0u128, u128::saturating_add);
        let history_events = sender_events
            .into_iter()
            .map(HistoryEvent::NoteCreated)
            .collect();
        actions.push(ClientAction {
            block_number,
            action_kind: ClientActionKind::TransferReceived { sender },
            token,
            amount,
            events: history_events,
        });
    }

    // Outgoing Created → TransferSent (grouped by recipient)
    for (recipient, recipient_events) in outgoing_by_recipient {
        let amount = recipient_events
            .iter()
            .map(|e| e.amount)
            .fold(0u128, u128::saturating_add);
        let history_events = recipient_events
            .into_iter()
            .map(HistoryEvent::NoteCreated)
            .collect();
        actions.push(ClientAction {
            block_number,
            action_kind: ClientActionKind::TransferSent { recipient },
            token,
            amount,
            events: history_events,
        });
    }

    // On-chain Deposit events (same token) → Deposit action
    if let Some(on_chain) = block_on_chain {
        for deposit_event in &on_chain.deposits {
            let PrivacyPoolEventContent::Deposit {
                user_address,
                token: event_token,
                amount: event_amount,
            } = &deposit_event.content
            else {
                continue;
            };
            if *event_token != token {
                continue;
            }
            let mut history_events: Vec<HistoryEvent> = self_channel_events
                .iter()
                .cloned()
                .map(HistoryEvent::NoteCreated)
                .collect();
            history_events.push(HistoryEvent::OnChain(deposit_event.clone()));
            actions.push(ClientAction {
                block_number,
                action_kind: ClientActionKind::Deposit {
                    from_address: Some(*user_address),
                },
                token,
                amount: *event_amount,
                events: history_events,
            });
        }

        // On-chain Withdrawal events (same token) → Withdrawal action
        for withdrawal_event in &on_chain.withdrawals {
            let PrivacyPoolEventContent::Withdrawal {
                to_address,
                token: event_token,
                amount: event_amount,
            } = &withdrawal_event.content
            else {
                continue;
            };
            if *event_token != token {
                continue;
            }
            let mut history_events: Vec<HistoryEvent> = self_channel_events
                .iter()
                .cloned()
                .map(HistoryEvent::NoteCreated)
                .collect();
            history_events.push(HistoryEvent::OnChain(withdrawal_event.clone()));
            actions.push(ClientAction {
                block_number,
                action_kind: ClientActionKind::Withdrawal {
                    to_address: Some(*to_address),
                },
                token,
                amount: *event_amount,
                events: history_events,
            });
        }
    }

    // Self-channel notes without matching on-chain deposit/withdrawal → Unknown
    let has_on_chain_match = block_on_chain.is_some_and(|oc| {
        oc.deposits
            .iter()
            .any(|d| matches!(&d.content, PrivacyPoolEventContent::Deposit { token: t, .. } if *t == token))
            || oc
                .withdrawals
                .iter()
                .any(|w| matches!(&w.content, PrivacyPoolEventContent::Withdrawal { token: t, .. } if *t == token))
    });
    if !self_channel_events.is_empty() && !has_on_chain_match {
        let amount = self_channel_events
            .iter()
            .map(|e| e.amount)
            .fold(0u128, u128::saturating_add);
        actions.push(ClientAction {
            block_number,
            action_kind: ClientActionKind::Unknown,
            token,
            amount,
            events: self_channel_events
                .into_iter()
                .map(HistoryEvent::NoteCreated)
                .collect(),
        });
    }

    // Open notes → SwapIn
    if !open_note_events.is_empty() {
        let amount = open_note_events
            .iter()
            .map(|e| e.amount)
            .fold(0u128, u128::saturating_add);
        actions.push(ClientAction {
            block_number,
            action_kind: ClientActionKind::SwapIn,
            token,
            amount,
            events: open_note_events
                .into_iter()
                .map(HistoryEvent::NoteCreated)
                .collect(),
        });
    }
}

/// Enriches swap actions by looking up `OpenNoteDeposited` on-chain events.
///
/// TODO: implement. For each SwapIn:
/// 1. Get the open note's `note_id`
/// 2. Fetch `OpenNoteDeposited` event by `note_id` key → get `depositor`, `tx_hash`
/// 3. Fetch all tx events → find Withdrawal where `to_addr == depositor`
/// 4. Create `SwapOut` with `to_address = depositor`
pub async fn enrich_swap_actions<E: IEvents>(
    _actions: &mut BTreeMap<u64, Vec<ClientAction>>,
    _event_access: &E,
) -> Result<(), DiscoveryError> {
    // TODO: implement via OpenNoteDeposited lookup
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::privacy_pool::events::{PrivacyPoolEvent, PrivacyPoolEventContent};

    const TEST_TOKEN: Felt = Felt::from_hex_unchecked("0x1");
    const SENDER_A: Felt = Felt::from_hex_unchecked("0xA");
    const SENDER_B: Felt = Felt::from_hex_unchecked("0xB");
    const RECIPIENT_A: Felt = Felt::from_hex_unchecked("0xCA");
    const USER_ADDR: Felt = Felt::from_hex_unchecked("0xDEAD");
    const WITHDRAWAL_TO: Felt = Felt::from_hex_unchecked("0xBEEF");
    const TX_HASH: Felt = Felt::from_hex_unchecked("0x999");

    fn make_event(channel_kind: ChannelKind, amount: u128, counterparty: Felt) -> CreateNoteEvent {
        CreateNoteEvent {
            channel_kind,
            token: TEST_TOKEN,
            note_index: 0,
            note_id: Felt::from(0x100u64),
            amount,
            counterparty,
            is_open: false,
        }
    }

    fn incoming_created(amount: u128, sender: Felt) -> CreateNoteEvent {
        make_event(ChannelKind::Incoming, amount, sender)
    }

    fn outgoing_created(amount: u128, recipient: Felt) -> CreateNoteEvent {
        make_event(ChannelKind::Outgoing, amount, recipient)
    }

    fn self_created(amount: u128) -> CreateNoteEvent {
        make_event(ChannelKind::SelfChannel, amount, Felt::ZERO)
    }

    fn make_deposit(
        block_number: u64,
        token: Felt,
        user_addr: Felt,
        amount: u128,
    ) -> PrivacyPoolEvent {
        PrivacyPoolEvent {
            block_number,
            transaction_hash: TX_HASH,
            content: PrivacyPoolEventContent::Deposit {
                user_address: user_addr,
                token,
                amount,
            },
        }
    }

    fn make_withdrawal(
        block_number: u64,
        token: Felt,
        to_addr: Felt,
        amount: u128,
    ) -> PrivacyPoolEvent {
        PrivacyPoolEvent {
            block_number,
            transaction_hash: TX_HASH,
            content: PrivacyPoolEventContent::Withdrawal {
                to_address: to_addr,
                token,
                amount,
            },
        }
    }

    fn empty_on_chain() -> BTreeMap<u64, BlockOnChainEvents> {
        BTreeMap::new()
    }

    /// Helper to collect all actions from a BTreeMap into a flat Vec (block-ordered).
    fn flatten_actions(actions_by_block: &BTreeMap<u64, Vec<ClientAction>>) -> Vec<&ClientAction> {
        actions_by_block.values().flat_map(|v| v.iter()).collect()
    }

    // --- Reconstruct tests ---

    #[test]
    fn empty_events_produce_no_actions() {
        assert!(reconstruct_client_actions(&BTreeMap::new(), &empty_on_chain()).is_empty());
    }

    #[test]
    fn incoming_created_is_transfer_received() {
        let mut events = BTreeMap::new();
        events.insert(5, vec![incoming_created(50, SENDER_A)]);
        let actions = reconstruct_client_actions(&events, &empty_on_chain());
        let flat = flatten_actions(&actions);
        assert_eq!(flat.len(), 1);
        assert_eq!(
            flat[0].action_kind,
            ClientActionKind::TransferReceived { sender: SENDER_A }
        );
        assert_eq!(flat[0].amount, 50);
    }

    #[test]
    fn outgoing_created_is_transfer_sent() {
        let mut events = BTreeMap::new();
        events.insert(15, vec![outgoing_created(200, RECIPIENT_A)]);
        let actions = reconstruct_client_actions(&events, &empty_on_chain());
        let flat = flatten_actions(&actions);
        assert_eq!(flat.len(), 1);
        assert_eq!(
            flat[0].action_kind,
            ClientActionKind::TransferSent {
                recipient: RECIPIENT_A
            }
        );
        assert_eq!(flat[0].amount, 200);
    }

    #[test]
    fn actions_ordered_by_block_number() {
        let mut events = BTreeMap::new();
        events.insert(100, vec![incoming_created(10, SENDER_A)]);
        events.insert(50, vec![incoming_created(20, SENDER_B)]);
        events.insert(200, vec![outgoing_created(30, RECIPIENT_A)]);
        let actions = reconstruct_client_actions(&events, &empty_on_chain());
        let flat = flatten_actions(&actions);
        assert_eq!(flat.len(), 3);
        assert_eq!(flat[0].block_number, 50);
        assert_eq!(flat[1].block_number, 100);
        assert_eq!(flat[2].block_number, 200);
    }

    #[test]
    fn incoming_grouped_by_sender() {
        let mut events = BTreeMap::new();
        events.insert(
            10,
            vec![
                incoming_created(30, SENDER_A),
                incoming_created(20, SENDER_B),
                incoming_created(50, SENDER_A),
            ],
        );
        let actions = reconstruct_client_actions(&events, &empty_on_chain());
        let flat = flatten_actions(&actions);
        assert_eq!(flat.len(), 2);
        // BTreeMap ordering: SENDER_A (0xA) < SENDER_B (0xB)
        assert_eq!(
            flat[0].action_kind,
            ClientActionKind::TransferReceived { sender: SENDER_A }
        );
        assert_eq!(flat[0].amount, 80);
        assert_eq!(flat[0].events.len(), 2);
        assert_eq!(
            flat[1].action_kind,
            ClientActionKind::TransferReceived { sender: SENDER_B }
        );
        assert_eq!(flat[1].amount, 20);
    }

    #[test]
    fn open_note_created_produces_swap_in() {
        let open_note = CreateNoteEvent {
            channel_kind: ChannelKind::SelfChannel,
            token: TEST_TOKEN,
            note_index: 0,
            note_id: Felt::from(0x200u64),
            amount: 50,
            counterparty: Felt::ZERO,
            is_open: true,
        };
        let mut events = BTreeMap::new();
        events.insert(80, vec![open_note]);
        let actions = reconstruct_client_actions(&events, &empty_on_chain());
        let flat = flatten_actions(&actions);
        assert_eq!(flat.len(), 1);
        assert_eq!(flat[0].action_kind, ClientActionKind::SwapIn);
        assert_eq!(flat[0].amount, 50);
        assert_eq!(flat[0].block_number, 80);
    }

    #[test]
    fn deposit_from_on_chain_event() {
        let mut events = BTreeMap::new();
        events.insert(10, vec![self_created(100)]);

        let mut on_chain = BTreeMap::new();
        on_chain.insert(
            10,
            BlockOnChainEvents {
                deposits: vec![make_deposit(10, TEST_TOKEN, USER_ADDR, 100)],
                withdrawals: vec![],
            },
        );

        let actions = reconstruct_client_actions(&events, &on_chain);
        let flat = flatten_actions(&actions);
        assert_eq!(flat.len(), 1);
        assert_eq!(
            flat[0].action_kind,
            ClientActionKind::Deposit {
                from_address: Some(USER_ADDR)
            }
        );
        assert_eq!(flat[0].amount, 100);
        assert_eq!(flat[0].block_number, 10);
        // Self-channel note + deposit event included
        assert_eq!(flat[0].events.len(), 2);
        assert!(matches!(flat[0].events[0], HistoryEvent::NoteCreated(_)));
        assert!(matches!(flat[0].events[1], HistoryEvent::OnChain(_)));
    }

    #[test]
    fn withdrawal_from_on_chain_event() {
        let mut events = BTreeMap::new();
        events.insert(20, vec![self_created(50)]);

        let mut on_chain = BTreeMap::new();
        on_chain.insert(
            20,
            BlockOnChainEvents {
                deposits: vec![],
                withdrawals: vec![make_withdrawal(20, TEST_TOKEN, WITHDRAWAL_TO, 75)],
            },
        );

        let actions = reconstruct_client_actions(&events, &on_chain);
        let flat = flatten_actions(&actions);
        assert_eq!(flat.len(), 1);
        assert_eq!(
            flat[0].action_kind,
            ClientActionKind::Withdrawal {
                to_address: Some(WITHDRAWAL_TO)
            }
        );
        assert_eq!(flat[0].amount, 75);
        assert_eq!(flat[0].block_number, 20);
        // Self-channel note + withdrawal event included
        assert_eq!(flat[0].events.len(), 2);
    }

    #[test]
    fn transfer_with_deposit() {
        // Transfer to recipient + deposit in the same block
        let mut events = BTreeMap::new();
        events.insert(
            60,
            vec![outgoing_created(100, RECIPIENT_A), self_created(100)],
        );

        let mut on_chain = BTreeMap::new();
        on_chain.insert(
            60,
            BlockOnChainEvents {
                deposits: vec![make_deposit(60, TEST_TOKEN, USER_ADDR, 200)],
                withdrawals: vec![],
            },
        );

        let actions = reconstruct_client_actions(&events, &on_chain);
        let flat = flatten_actions(&actions);
        assert_eq!(flat.len(), 2);
        assert_eq!(
            flat[0].action_kind,
            ClientActionKind::TransferSent {
                recipient: RECIPIENT_A
            }
        );
        assert_eq!(flat[0].amount, 100);
        assert_eq!(
            flat[1].action_kind,
            ClientActionKind::Deposit {
                from_address: Some(USER_ADDR)
            }
        );
        assert_eq!(flat[1].amount, 200);
    }

    #[test]
    fn self_channel_only_produces_unknown() {
        let mut events = BTreeMap::new();
        events.insert(30, vec![self_created(100)]);

        // No on-chain events for this block
        let actions = reconstruct_client_actions(&events, &empty_on_chain());
        let flat = flatten_actions(&actions);
        assert_eq!(flat.len(), 1);
        assert_eq!(flat[0].action_kind, ClientActionKind::Unknown);
        assert_eq!(flat[0].amount, 100);
        assert_eq!(flat[0].block_number, 30);
        assert_eq!(flat[0].events.len(), 1);
    }

    #[test]
    fn withdrawal_promoted_to_swap_out_with_swap_in() {
        let open_note = CreateNoteEvent {
            channel_kind: ChannelKind::SelfChannel,
            token: TEST_TOKEN,
            note_index: 1,
            note_id: Felt::from(0x300u64),
            amount: 60,
            counterparty: Felt::ZERO,
            is_open: true,
        };
        let mut events = BTreeMap::new();
        events.insert(90, vec![self_created(40), open_note]);

        let mut on_chain = BTreeMap::new();
        on_chain.insert(
            90,
            BlockOnChainEvents {
                deposits: vec![],
                withdrawals: vec![make_withdrawal(90, TEST_TOKEN, WITHDRAWAL_TO, 100)],
            },
        );

        let actions = reconstruct_client_actions(&events, &on_chain);
        let flat = flatten_actions(&actions);
        assert_eq!(flat.len(), 2);
        // Withdrawal promoted to SwapOut because SwapIn exists in same block
        assert_eq!(
            flat[0].action_kind,
            ClientActionKind::SwapOut {
                to_address: Some(WITHDRAWAL_TO)
            }
        );
        assert_eq!(flat[0].amount, 100);
        assert_eq!(flat[1].action_kind, ClientActionKind::SwapIn);
        assert_eq!(flat[1].amount, 60);
    }

    #[test]
    fn on_chain_event_different_token_ignored() {
        let other_token = Felt::from_hex_unchecked("0x999");
        let mut events = BTreeMap::new();
        events.insert(10, vec![self_created(100)]);

        let mut on_chain = BTreeMap::new();
        on_chain.insert(
            10,
            BlockOnChainEvents {
                deposits: vec![make_deposit(10, other_token, USER_ADDR, 100)],
                withdrawals: vec![],
            },
        );

        // On-chain deposit is for a different token, so self-channel → Unknown
        let actions = reconstruct_client_actions(&events, &on_chain);
        let flat = flatten_actions(&actions);
        assert_eq!(flat.len(), 1);
        assert_eq!(flat[0].action_kind, ClientActionKind::Unknown);
    }

    #[test]
    fn actions_grouped_by_block_in_result() {
        let mut events = BTreeMap::new();
        events.insert(10, vec![incoming_created(50, SENDER_A)]);
        events.insert(20, vec![outgoing_created(100, RECIPIENT_A)]);

        let actions = reconstruct_client_actions(&events, &empty_on_chain());
        assert_eq!(actions.len(), 2);
        assert!(actions.contains_key(&10));
        assert!(actions.contains_key(&20));
        assert_eq!(actions[&10].len(), 1);
        assert_eq!(actions[&20].len(), 1);
    }
}
