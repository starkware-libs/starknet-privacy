//! Typed privacy pool events and blanket implementation.
//!
//! Mirrors [`super::views`]: defines a unified [`PrivacyPoolEvent`] type with
//! variant-specific content, and an [`IEvents`] trait with a blanket
//! implementation over [`RawEventAccess`].

use std::sync::LazyLock;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use starknet_core::utils::starknet_keccak;
use starknet_types_core::felt::Felt;

use super::types::{felt_low_u128, u128_as_string};
use crate::events_backend::{EmittedEvent, RawEventAccess};
use crate::storage_backend::StorageError;

static DEPOSIT_SELECTOR: LazyLock<Felt> = LazyLock::new(|| starknet_keccak(b"Deposit"));
static WITHDRAWAL_SELECTOR: LazyLock<Felt> = LazyLock::new(|| starknet_keccak(b"Withdrawal"));
static ENC_NOTE_CREATED_SELECTOR: LazyLock<Felt> =
    LazyLock::new(|| starknet_keccak(b"EncNoteCreated"));
static OPEN_NOTE_DEPOSITED_SELECTOR: LazyLock<Felt> =
    LazyLock::new(|| starknet_keccak(b"OpenNoteDeposited"));

/// A typed privacy pool contract event with block context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrivacyPoolEvent {
    pub block_number: u64,
    pub transaction_hash: Felt,
    pub content: PrivacyPoolEventContent,
}

/// Decoded fields for a Cairo `Deposit` event.
/// Keys = `[selector, user_addr, token]`, data = `[amount]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DepositEvent {
    pub user_address: Felt,
    pub token: Felt,
    #[serde(with = "u128_as_string")]
    pub amount: u128,
}

/// Decoded fields for a Cairo `Withdrawal` event.
/// Keys = `[selector, to_addr, token]`, data = `[enc_user_addr(3), amount]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WithdrawalEvent {
    pub to_address: Felt,
    pub token: Felt,
    #[serde(with = "u128_as_string")]
    pub amount: u128,
}

/// Decoded fields for a Cairo `EncNoteCreated` event.
/// Keys = `[selector, note_id]`, data = `[packed_value]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncNoteCreatedEvent {
    pub note_id: Felt,
    pub packed_value: Felt,
}

/// Decoded fields for a Cairo `OpenNoteDeposited` event.
/// Keys = `[selector, depositor, token, note_id]`, data = `[amount]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenNoteDepositedEvent {
    pub depositor: Felt,
    pub token: Felt,
    pub note_id: Felt,
    #[serde(with = "u128_as_string")]
    pub amount: u128,
}

/// Event-specific content for privacy pool contract events.
///
/// Each variant corresponds to a Cairo event type with its decoded fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PrivacyPoolEventContent {
    Deposit(DepositEvent),
    Withdrawal(WithdrawalEvent),
    EncNoteCreated(EncNoteCreatedEvent),
    OpenNoteDeposited(OpenNoteDepositedEvent),
}

/// Typed event access for privacy pool contract events.
#[async_trait]
pub trait IEvents: Send + Sync {
    /// Fetches all privacy pool events in a single block.
    ///
    /// Parses all known event types (Deposit, Withdrawal, EncNoteCreated, OpenNoteDeposited).
    /// Unknown selectors are silently skipped. Malformed known events return an error.
    async fn get_block_events(
        &self,
        block_number: u64,
    ) -> Result<Vec<PrivacyPoolEvent>, StorageError>;

    /// Fetches `Withdrawal` events for the given address within a block range (inclusive).
    ///
    /// The address matches the recipient (key position 1 in `Withdrawal`).
    async fn get_withdrawal_events(
        &self,
        address: Felt,
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<PrivacyPoolEvent>, StorageError>;
}

/// Reason a raw event could not be converted to a typed event.
#[derive(Debug)]
pub enum EventParseError {
    /// Unknown or missing selector — not a privacy pool event.
    UnknownSelector,
    /// Known selector but malformed fields.
    Malformed(String),
}

impl From<EventParseError> for StorageError {
    fn from(err: EventParseError) -> Self {
        match err {
            EventParseError::UnknownSelector => {
                StorageError::Backend("unknown event selector".into())
            }
            EventParseError::Malformed(message) => StorageError::Backend(message.into()),
        }
    }
}

impl TryFrom<EmittedEvent> for PrivacyPoolEvent {
    type Error = EventParseError;

    fn try_from(event: EmittedEvent) -> Result<Self, Self::Error> {
        let selector = event
            .keys
            .first()
            .copied()
            .ok_or(EventParseError::UnknownSelector)?;

        let content = if selector == *DEPOSIT_SELECTOR {
            PrivacyPoolEventContent::Deposit(DepositEvent {
                user_address: required_key(&event, 1, "user_addr")?,
                token: required_key(&event, 2, "token")?,
                amount: required_amount(&event, 0)?,
            })
        } else if selector == *WITHDRAWAL_SELECTOR {
            PrivacyPoolEventContent::Withdrawal(WithdrawalEvent {
                to_address: required_key(&event, 1, "to_addr")?,
                token: required_key(&event, 2, "token")?,
                amount: required_amount(&event, 3)?,
            })
        } else if selector == *ENC_NOTE_CREATED_SELECTOR {
            let packed_value =
                event.data.first().copied().ok_or_else(|| {
                    EventParseError::Malformed("missing packed_value data".into())
                })?;
            PrivacyPoolEventContent::EncNoteCreated(EncNoteCreatedEvent {
                note_id: required_key(&event, 1, "note_id")?,
                packed_value,
            })
        } else if selector == *OPEN_NOTE_DEPOSITED_SELECTOR {
            PrivacyPoolEventContent::OpenNoteDeposited(OpenNoteDepositedEvent {
                depositor: required_key(&event, 1, "depositor")?,
                token: required_key(&event, 2, "token")?,
                note_id: required_key(&event, 3, "note_id")?,
                amount: required_amount(&event, 0)?,
            })
        } else {
            return Err(EventParseError::UnknownSelector);
        };

        let block_number = event
            .block_number
            .ok_or_else(|| EventParseError::Malformed("event missing block_number".into()))?;

        Ok(PrivacyPoolEvent {
            block_number,
            transaction_hash: event.transaction_hash,
            content,
        })
    }
}

/// Converts raw events to typed events, skipping unknown selectors.
///
/// Malformed known events return an error.
fn parse_events(raw_events: Vec<EmittedEvent>) -> Result<Vec<PrivacyPoolEvent>, StorageError> {
    raw_events
        .into_iter()
        .filter_map(|event| match PrivacyPoolEvent::try_from(event) {
            Ok(parsed) => Some(Ok(parsed)),
            Err(EventParseError::UnknownSelector) => None,
            Err(err) => Some(Err(StorageError::from(err))),
        })
        .collect()
}

#[async_trait]
impl<T: RawEventAccess> IEvents for T {
    async fn get_block_events(
        &self,
        block_number: u64,
    ) -> Result<Vec<PrivacyPoolEvent>, StorageError> {
        let selectors = vec![
            *DEPOSIT_SELECTOR,
            *WITHDRAWAL_SELECTOR,
            *ENC_NOTE_CREATED_SELECTOR,
            *OPEN_NOTE_DEPOSITED_SELECTOR,
        ];
        let raw_events = self
            .get_events(&[selectors], block_number, block_number)
            .await?;
        parse_events(raw_events)
    }

    async fn get_withdrawal_events(
        &self,
        address: Felt,
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<PrivacyPoolEvent>, StorageError> {
        let raw_events = self
            .get_events(
                &[vec![*WITHDRAWAL_SELECTOR], vec![address]],
                from_block,
                to_block,
            )
            .await?;
        parse_events(raw_events)
    }
}

fn required_key(
    event: &EmittedEvent,
    position: usize,
    field: &str,
) -> Result<Felt, EventParseError> {
    event
        .keys
        .get(position)
        .copied()
        .ok_or_else(|| EventParseError::Malformed(format!("missing {field} key")))
}

fn required_amount(event: &EmittedEvent, index: usize) -> Result<u128, EventParseError> {
    event
        .data
        .get(index)
        .map(|f| felt_low_u128(*f))
        .ok_or_else(|| EventParseError::Malformed("missing amount data".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events_backend::{mock_event, MockEventBackend};

    const USER: Felt = Felt::from_hex_unchecked("0xABCD");
    const TOKEN: Felt = Felt::from_hex_unchecked("0x1");
    const TX_HASH: Felt = Felt::from_hex_unchecked("0x999");

    #[tokio::test]
    async fn get_block_events_returns_all_event_types() {
        let note_id = Felt::from(0x42u64);
        let packed_value = Felt::from(0xDEADu64);
        let depositor = Felt::from(0xCAFEu64);
        let unknown_selector = Felt::from(0xFFFFu64);

        let backend = MockEventBackend::new(vec![
            mock_event(
                10,
                TX_HASH,
                vec![*DEPOSIT_SELECTOR, USER, TOKEN],
                vec![Felt::from(100u64)],
            ),
            mock_event(
                10,
                TX_HASH,
                vec![*ENC_NOTE_CREATED_SELECTOR, note_id],
                vec![packed_value],
            ),
            // Unknown event — should be skipped
            mock_event(10, TX_HASH, vec![unknown_selector], vec![Felt::ONE]),
            mock_event(
                10,
                TX_HASH,
                vec![*OPEN_NOTE_DEPOSITED_SELECTOR, depositor, TOKEN, note_id],
                vec![Felt::from(200u64)],
            ),
        ]);

        let events = backend.get_block_events(10).await.unwrap();
        assert_eq!(events.len(), 3);
        assert!(matches!(
            events[0].content,
            PrivacyPoolEventContent::Deposit(_)
        ));
        assert!(matches!(
            events[1].content,
            PrivacyPoolEventContent::EncNoteCreated(_)
        ));
        assert!(matches!(
            events[2].content,
            PrivacyPoolEventContent::OpenNoteDeposited(_)
        ));
    }

    #[tokio::test]
    async fn get_block_events_skips_keyless_events() {
        let backend = MockEventBackend::new(vec![mock_event(10, TX_HASH, vec![], vec![Felt::ONE])]);
        let events = backend.get_block_events(10).await.unwrap();
        assert!(events.is_empty());
    }

    #[tokio::test]
    async fn get_block_events_filters_by_block() {
        let backend = MockEventBackend::new(vec![
            mock_event(
                10,
                TX_HASH,
                vec![*DEPOSIT_SELECTOR, USER, TOKEN],
                vec![Felt::from(100u64)],
            ),
            mock_event(
                20,
                TX_HASH,
                vec![*DEPOSIT_SELECTOR, USER, TOKEN],
                vec![Felt::from(200u64)],
            ),
        ]);

        let events = backend.get_block_events(10).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].block_number, 10);
    }

    #[tokio::test]
    async fn get_block_events_parses_deposit() {
        let backend = MockEventBackend::new(vec![mock_event(
            10,
            TX_HASH,
            vec![*DEPOSIT_SELECTOR, USER, TOKEN],
            vec![Felt::from(100u64)],
        )]);

        let events = backend.get_block_events(10).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].block_number, 10);
        assert_eq!(events[0].transaction_hash, TX_HASH);
        let PrivacyPoolEventContent::Deposit(deposit) = &events[0].content else {
            panic!("expected Deposit");
        };
        assert_eq!(deposit.user_address, USER);
        assert_eq!(deposit.token, TOKEN);
        assert_eq!(deposit.amount, 100);
    }

    #[tokio::test]
    async fn get_block_events_parses_withdrawal_data_index_3() {
        let to_addr = Felt::from(0xBEEFu64);
        let backend = MockEventBackend::new(vec![mock_event(
            20,
            TX_HASH,
            vec![*WITHDRAWAL_SELECTOR, to_addr, TOKEN],
            // data: [enc_user_addr(3 felts), amount]
            vec![Felt::ZERO, Felt::ZERO, Felt::ZERO, Felt::from(75u64)],
        )]);

        let events = backend.get_block_events(20).await.unwrap();
        assert_eq!(events.len(), 1);
        let PrivacyPoolEventContent::Withdrawal(withdrawal) = &events[0].content else {
            panic!("expected Withdrawal");
        };
        assert_eq!(withdrawal.to_address, to_addr);
        assert_eq!(withdrawal.token, TOKEN);
        assert_eq!(withdrawal.amount, 75);
    }

    #[tokio::test]
    async fn get_withdrawal_events_filters_by_address() {
        let alice = Felt::from(0xA11CEu64);
        let bob = Felt::from(0xB0Bu64);
        let backend = MockEventBackend::new(vec![
            mock_event(
                10,
                TX_HASH,
                vec![*WITHDRAWAL_SELECTOR, alice, TOKEN],
                vec![Felt::ZERO, Felt::ZERO, Felt::ZERO, Felt::from(50u64)],
            ),
            mock_event(
                10,
                TX_HASH,
                vec![*WITHDRAWAL_SELECTOR, bob, TOKEN],
                vec![Felt::ZERO, Felt::ZERO, Felt::ZERO, Felt::from(75u64)],
            ),
        ]);

        let events = backend.get_withdrawal_events(alice, 0, 100).await.unwrap();
        assert_eq!(events.len(), 1);
        let PrivacyPoolEventContent::Withdrawal(withdrawal) = &events[0].content else {
            panic!("expected Withdrawal");
        };
        assert_eq!(withdrawal.to_address, alice);
        assert_eq!(withdrawal.amount, 50);
    }

    #[tokio::test]
    async fn get_withdrawal_events_excludes_deposits() {
        let backend = MockEventBackend::new(vec![
            mock_event(
                10,
                TX_HASH,
                vec![*DEPOSIT_SELECTOR, USER, TOKEN],
                vec![Felt::from(100u64)],
            ),
            mock_event(
                10,
                TX_HASH,
                vec![*WITHDRAWAL_SELECTOR, USER, TOKEN],
                vec![Felt::ZERO, Felt::ZERO, Felt::ZERO, Felt::from(50u64)],
            ),
        ]);

        let events = backend.get_withdrawal_events(USER, 0, 100).await.unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events[0].content,
            PrivacyPoolEventContent::Withdrawal(_)
        ));
    }

    #[tokio::test]
    async fn get_withdrawal_events_respects_block_range() {
        let backend = MockEventBackend::new(vec![
            mock_event(
                10,
                TX_HASH,
                vec![*WITHDRAWAL_SELECTOR, USER, TOKEN],
                vec![Felt::ZERO, Felt::ZERO, Felt::ZERO, Felt::from(50u64)],
            ),
            mock_event(
                20,
                TX_HASH,
                vec![*WITHDRAWAL_SELECTOR, USER, TOKEN],
                vec![Felt::ZERO, Felt::ZERO, Felt::ZERO, Felt::from(75u64)],
            ),
        ]);

        let events = backend.get_withdrawal_events(USER, 15, 100).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].block_number, 20);
    }

    #[tokio::test]
    async fn malformed_deposit_event_returns_error() {
        let backend = MockEventBackend::new(vec![mock_event(
            10,
            TX_HASH,
            vec![*DEPOSIT_SELECTOR, USER], // missing token key
            vec![Felt::from(100u64)],
        )]);

        let result = backend.get_block_events(10).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn malformed_withdrawal_short_data_returns_error() {
        let to_addr = Felt::from(0xBEEFu64);
        let backend = MockEventBackend::new(vec![mock_event(
            20,
            TX_HASH,
            vec![*WITHDRAWAL_SELECTOR, to_addr, TOKEN],
            vec![Felt::ZERO, Felt::ZERO], // only 2 data elements, need 4
        )]);

        let result = backend.get_block_events(20).await;
        assert!(result.is_err());
    }
}
