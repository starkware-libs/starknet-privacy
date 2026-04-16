//! Types for the backward history scan.

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

use crate::privacy_pool::events::{DepositEvent, OpenNoteDepositedEvent, WithdrawalEvent};
use crate::privacy_pool::types::{secret_felt_serde, u128_as_string, SecretFelt};

/// The relationship between the user and a channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelKind {
    Incoming,
    Outgoing,
    SelfChannel,
}

/// A decrypted note enriched with channel context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryNote {
    pub channel_kind: ChannelKind,
    pub token: Felt,
    pub note_index: u64,
    pub note_id: Felt,
    pub counterparty: Felt,
    #[serde(with = "u128_as_string")]
    pub amount: u128,
    #[serde(with = "u128_as_string")]
    pub salt: u128,
}

/// A transaction's events grouped and typed for history display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryTransaction {
    pub block_number: u64,
    pub transaction_hash: Felt,
    pub notes: Vec<HistoryNote>,
    pub deposits: Vec<DepositEvent>,
    pub withdrawals: Vec<WithdrawalEvent>,
    pub open_note_deposits: Vec<OpenNoteDepositedEvent>,
    /// The user's registered public key. Present only on the synthetic
    /// registration transaction appended at the end of history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registered_pubkey: Option<Felt>,
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
            registered_pubkey: None,
        }
    }
}

/// A single subchannel in the backward history scan (note creation reads only).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistorySubchannel {
    #[serde(
        serialize_with = "secret_felt_serde::serialize",
        deserialize_with = "secret_felt_serde::deserialize"
    )]
    pub channel_key: SecretFelt,
    pub token: Felt,
    pub channel_kind: ChannelKind,
    pub counterparty: Felt,
    /// Next note index to read (descending). None = stream exhausted.
    pub next_index: Option<u64>,
}

/// Cursor for paginated backward history scan across multiple subchannels.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HistoryCursor {
    pub subchannels: Vec<HistorySubchannel>,
    /// Inclusive upper bound for event queries (block number). `None` on the
    /// first page — the caller provides the upper bound separately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub begin_block_number: Option<u64>,
    /// `true` = all subchannels exhausted, no more history.
    /// `false` = stopped due to budget or max_transactions limit.
    pub history_complete: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_history_note_serializes_amounts_as_strings() {
        let note = HistoryNote {
            channel_kind: ChannelKind::Incoming,
            token: Felt::from(0x1u64),
            note_index: 0,
            note_id: Felt::from(0x42u64),
            counterparty: Felt::from(0xABCDu64),
            amount: (1u128 << 53) + 1,
            salt: u128::MAX,
        };

        let json = serde_json::to_value(&note).unwrap();
        assert!(json["amount"].is_string(), "amount must be a JSON string");
        assert!(json["salt"].is_string(), "salt must be a JSON string");

        let restored: HistoryNote = serde_json::from_value(json).unwrap();
        assert_eq!(restored, note);
    }

    #[test]
    fn test_history_transaction_serializes_event_amounts_as_strings() {
        let transaction = HistoryTransaction {
            block_number: 10,
            transaction_hash: Felt::from(0x999u64),
            notes: Vec::new(),
            deposits: vec![DepositEvent {
                user_address: Felt::from(0xAu64),
                token: Felt::from(0x1u64),
                amount: (1u128 << 53) + 1,
            }],
            withdrawals: vec![WithdrawalEvent {
                to_address: Felt::from(0xBu64),
                token: Felt::from(0x1u64),
                amount: u128::MAX,
            }],
            open_note_deposits: vec![OpenNoteDepositedEvent {
                depositor: Felt::from(0xCu64),
                token: Felt::from(0x1u64),
                note_id: Felt::from(0x42u64),
                amount: 0,
            }],
            registered_pubkey: None,
        };

        let json = serde_json::to_value(&transaction).unwrap();
        assert!(json["deposits"][0]["amount"].is_string());
        assert!(json["withdrawals"][0]["amount"].is_string());
        assert!(json["open_note_deposits"][0]["amount"].is_string());

        let restored: HistoryTransaction = serde_json::from_value(json).unwrap();
        assert_eq!(restored, transaction);
    }

    #[test]
    fn test_registered_pubkey_omitted_when_none() {
        let transaction = HistoryTransaction::new(10, Felt::from(0x999u64));
        let json = serde_json::to_value(&transaction).unwrap();
        assert!(
            json.get("registered_pubkey").is_none(),
            "registered_pubkey must be omitted when None"
        );

        let restored: HistoryTransaction = serde_json::from_value(json).unwrap();
        assert_eq!(restored.registered_pubkey, None);
    }

    #[test]
    fn test_registered_pubkey_round_trips_when_present() {
        let mut transaction = HistoryTransaction::new(5, Felt::ZERO);
        transaction.registered_pubkey = Some(Felt::from(0xCAFEu64));

        let json = serde_json::to_value(&transaction).unwrap();
        assert!(json.get("registered_pubkey").is_some());

        let restored: HistoryTransaction = serde_json::from_value(json).unwrap();
        assert_eq!(restored.registered_pubkey, Some(Felt::from(0xCAFEu64)));
    }
}
