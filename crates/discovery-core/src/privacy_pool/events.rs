//! Typed privacy pool events and blanket implementation.
//!
//! Mirrors [`super::views`]: defines a unified [`PrivacyPoolEvent`] type with
//! variant-specific content, and an [`IEvents`] trait with a blanket
//! implementation over [`RawEventAccess`].

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use starknet_core::utils::starknet_keccak;
use starknet_types_core::felt::Felt;

use super::types::felt_low_u128;
use crate::events_backend::RawEventAccess;
use crate::storage_backend::StorageError;

/// A typed privacy pool contract event with block context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrivacyPoolEvent {
    pub block_number: u64,
    pub transaction_hash: Felt,
    pub content: PrivacyPoolEventContent,
}

/// Event-specific content for privacy pool contract events.
///
/// Each variant corresponds to a Cairo event type with its decoded fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PrivacyPoolEventContent {
    /// Cairo `Deposit`: keys = `[selector, user_addr, token]`, data = `[amount]`.
    Deposit {
        user_address: Felt,
        token: Felt,
        amount: u128,
    },
    /// Cairo `Withdrawal`: keys = `[selector, to_addr, token]`, data = `[enc_user_addr(3), amount]`.
    Withdrawal {
        to_address: Felt,
        token: Felt,
        amount: u128,
    },
    /// Cairo `OpenNoteDeposited`: keys = `[selector, depositor, token, note_id]`, data = `[amount]`.
    OpenNoteDeposited {
        depositor: Felt,
        token: Felt,
        note_id: Felt,
        amount: u128,
    },
}

use crate::events_backend::EmittedEvent;

/// Extracts a required key at `position` from a raw event, or returns `StorageError::Backend`.
fn required_key(event: &EmittedEvent, position: usize, field: &str) -> Result<Felt, StorageError> {
    event
        .keys
        .get(position)
        .copied()
        .ok_or_else(|| StorageError::Backend(format!("missing {field} key").into()))
}

/// Extracts a `u128` amount from event data at `index`, or returns `StorageError::Backend`.
fn required_amount(event: &EmittedEvent, index: usize) -> Result<u128, StorageError> {
    event
        .data
        .get(index)
        .map(|f| felt_low_u128(*f))
        .ok_or_else(|| StorageError::Backend("missing amount data".into()))
}

/// Parses raw events into typed [`PrivacyPoolEvent`]s using a content-building closure.
///
/// Handles the common wrapping of `block_number` and `transaction_hash`; the closure
/// only needs to produce the variant-specific [`PrivacyPoolEventContent`].
fn parse_events(
    raw_events: Vec<EmittedEvent>,
    build_content: impl Fn(&EmittedEvent) -> Result<PrivacyPoolEventContent, StorageError>,
) -> Result<Vec<PrivacyPoolEvent>, StorageError> {
    raw_events
        .into_iter()
        .map(|event| {
            let content = build_content(&event)?;
            Ok(PrivacyPoolEvent {
                block_number: event.block_number,
                transaction_hash: event.transaction_hash,
                content,
            })
        })
        .collect()
}

/// Typed event access for privacy pool contract events.
#[async_trait]
pub trait IEvents: Send + Sync {
    /// Fetches `Deposit` events for the given user address within a block range (inclusive).
    async fn get_deposit_events(
        &self,
        user_address: Felt,
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<PrivacyPoolEvent>, StorageError>;

    /// Fetches `Withdrawal` events for the given recipient address within a block range (inclusive).
    async fn get_withdrawal_events(
        &self,
        to_address: Felt,
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<PrivacyPoolEvent>, StorageError>;

    /// Fetches `OpenNoteDeposited` events for the given note IDs within a block range (inclusive).
    ///
    /// Accepts multiple `note_id` values; the RPC key filter matches any of them.
    async fn get_open_note_deposited_events(
        &self,
        note_ids: &[Felt],
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<PrivacyPoolEvent>, StorageError>;
}

#[async_trait]
impl<T: RawEventAccess> IEvents for T {
    async fn get_deposit_events(
        &self,
        user_address: Felt,
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<PrivacyPoolEvent>, StorageError> {
        let selector = starknet_keccak(b"Deposit");
        let raw_events = self
            .get_events(&[vec![selector], vec![user_address]], from_block, to_block)
            .await?;

        parse_events(raw_events, |event| {
            Ok(PrivacyPoolEventContent::Deposit {
                user_address: required_key(event, 1, "user_addr")?,
                token: required_key(event, 2, "token")?,
                amount: required_amount(event, 0)?,
            })
        })
    }

    async fn get_withdrawal_events(
        &self,
        to_address: Felt,
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<PrivacyPoolEvent>, StorageError> {
        let selector = starknet_keccak(b"Withdrawal");
        let raw_events = self
            .get_events(&[vec![selector], vec![to_address]], from_block, to_block)
            .await?;

        // data = [enc_user_addr(3 felts), amount] → amount at index 3
        parse_events(raw_events, |event| {
            Ok(PrivacyPoolEventContent::Withdrawal {
                to_address: required_key(event, 1, "to_addr")?,
                token: required_key(event, 2, "token")?,
                amount: required_amount(event, 3)?,
            })
        })
    }

    async fn get_open_note_deposited_events(
        &self,
        note_ids: &[Felt],
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<PrivacyPoolEvent>, StorageError> {
        let selector = starknet_keccak(b"OpenNoteDeposited");
        // keys = [selector, depositor, token, note_id]
        // Filter by selector and note_ids at position 3 (multi-key match)
        let raw_events = self
            .get_events(
                &[vec![selector], vec![], vec![], note_ids.to_vec()],
                from_block,
                to_block,
            )
            .await?;

        parse_events(raw_events, |event| {
            Ok(PrivacyPoolEventContent::OpenNoteDeposited {
                depositor: required_key(event, 1, "depositor")?,
                token: required_key(event, 2, "token")?,
                note_id: required_key(event, 3, "note_id")?,
                amount: required_amount(event, 0)?,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events_backend::{EmittedEvent, MockEventBackend};

    const USER: Felt = Felt::from_hex_unchecked("0xABCD");
    const TOKEN: Felt = Felt::from_hex_unchecked("0x1");
    const TX_HASH: Felt = Felt::from_hex_unchecked("0x999");

    fn deposit_selector() -> Felt {
        starknet_keccak(b"Deposit")
    }

    fn withdrawal_selector() -> Felt {
        starknet_keccak(b"Withdrawal")
    }

    fn open_note_deposited_selector() -> Felt {
        starknet_keccak(b"OpenNoteDeposited")
    }

    #[tokio::test]
    async fn parse_deposit_event() {
        let backend = MockEventBackend::new(vec![EmittedEvent {
            block_number: 10,
            transaction_hash: TX_HASH,
            keys: vec![deposit_selector(), USER, TOKEN],
            data: vec![Felt::from(100u64)],
        }]);

        let deposits = backend.get_deposit_events(USER, 0, 100).await.unwrap();
        assert_eq!(deposits.len(), 1);
        assert_eq!(deposits[0].block_number, 10);
        assert_eq!(deposits[0].transaction_hash, TX_HASH);
        let PrivacyPoolEventContent::Deposit {
            user_address,
            token,
            amount,
        } = &deposits[0].content
        else {
            panic!("expected Deposit");
        };
        assert_eq!(*user_address, USER);
        assert_eq!(*token, TOKEN);
        assert_eq!(*amount, 100);
    }

    #[tokio::test]
    async fn parse_withdrawal_event_extracts_data_index_3() {
        let to_addr = Felt::from(0xBEEFu64);
        let backend = MockEventBackend::new(vec![EmittedEvent {
            block_number: 20,
            transaction_hash: TX_HASH,
            keys: vec![withdrawal_selector(), to_addr, TOKEN],
            // data: [enc_user_addr(3 felts), amount]
            data: vec![Felt::ZERO, Felt::ZERO, Felt::ZERO, Felt::from(75u64)],
        }]);

        let withdrawals = backend
            .get_withdrawal_events(to_addr, 0, 100)
            .await
            .unwrap();
        assert_eq!(withdrawals.len(), 1);
        let PrivacyPoolEventContent::Withdrawal {
            to_address,
            token,
            amount,
        } = &withdrawals[0].content
        else {
            panic!("expected Withdrawal");
        };
        assert_eq!(*to_address, to_addr);
        assert_eq!(*token, TOKEN);
        assert_eq!(*amount, 75);
    }

    #[tokio::test]
    async fn parse_open_note_deposited_event() {
        let depositor = Felt::from(0xCAFEu64);
        let note_id = Felt::from(0x42u64);
        let backend = MockEventBackend::new(vec![EmittedEvent {
            block_number: 30,
            transaction_hash: TX_HASH,
            keys: vec![open_note_deposited_selector(), depositor, TOKEN, note_id],
            data: vec![Felt::from(200u64)],
        }]);

        let events = backend
            .get_open_note_deposited_events(&[note_id], 0, 100)
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        let PrivacyPoolEventContent::OpenNoteDeposited {
            depositor: actual_depositor,
            token,
            note_id: actual_note_id,
            amount,
        } = &events[0].content
        else {
            panic!("expected OpenNoteDeposited");
        };
        assert_eq!(*actual_depositor, depositor);
        assert_eq!(*token, TOKEN);
        assert_eq!(*actual_note_id, note_id);
        assert_eq!(*amount, 200);
    }

    #[tokio::test]
    async fn malformed_deposit_event_returns_error() {
        let backend = MockEventBackend::new(vec![EmittedEvent {
            block_number: 10,
            transaction_hash: TX_HASH,
            keys: vec![deposit_selector(), USER], // missing token key
            data: vec![Felt::from(100u64)],
        }]);

        let result = backend.get_deposit_events(USER, 0, 100).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn malformed_withdrawal_short_data_returns_error() {
        let to_addr = Felt::from(0xBEEFu64);
        let backend = MockEventBackend::new(vec![EmittedEvent {
            block_number: 20,
            transaction_hash: TX_HASH,
            keys: vec![withdrawal_selector(), to_addr, TOKEN],
            data: vec![Felt::ZERO, Felt::ZERO], // only 2 data elements, need 4
        }]);

        let result = backend.get_withdrawal_events(to_addr, 0, 100).await;
        assert!(result.is_err());
    }
}
