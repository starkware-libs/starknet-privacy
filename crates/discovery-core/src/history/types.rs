//! Types for the backward history scan.

use starknet_types_core::felt::Felt;

use crate::privacy_pool::events::{DepositEvent, OpenNoteDepositedEvent, WithdrawalEvent};
use crate::privacy_pool::types::SecretFelt;

/// The relationship between the user and a channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    Incoming,
    Outgoing,
    SelfChannel,
}

/// A decrypted note enriched with channel context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryNote {
    pub channel_kind: ChannelKind,
    pub token: Felt,
    pub note_index: u64,
    pub note_id: Felt,
    pub counterparty: Felt,
    pub amount: u128,
    pub salt: u128,
}

/// A transaction's events grouped and typed for history display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryTransaction {
    pub block_number: u64,
    pub transaction_hash: Felt,
    pub notes: Vec<HistoryNote>,
    pub deposits: Vec<DepositEvent>,
    pub withdrawals: Vec<WithdrawalEvent>,
    pub open_note_deposits: Vec<OpenNoteDepositedEvent>,
}

impl HistoryTransaction {
    pub fn new(block_number: u64, transaction_hash: Felt) -> Self {
        Self {
            block_number,
            transaction_hash,
            notes: Vec::new(),
            deposits: Vec::new(),
            withdrawals: Vec::new(),
            open_note_deposits: Vec::new(),
        }
    }
}

/// A single subchannel in the backward history scan (note creation reads only).
pub struct HistorySubchannel {
    pub channel_key: SecretFelt,
    pub token: Felt,
    pub channel_kind: ChannelKind,
    pub counterparty: Felt,
    /// Next note index to read (descending). None = stream exhausted.
    pub next_index: Option<u64>,
}

/// Cursor for paginated backward history scan across multiple subchannels.
pub struct HistoryCursor {
    pub subchannels: Vec<HistorySubchannel>,
    /// Inclusive upper bound for event queries — the block where backward scanning begins.
    /// Typically set to the latest confirmed block when the scan starts.
    pub begin_block_number: u64,
    /// `true` = all subchannels exhausted, no more history.
    /// `false` = stopped due to budget or max_transactions limit.
    pub history_complete: bool,
}
