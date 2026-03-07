//! On-chain event fetching and block grouping.
//!
//! Fetches typed deposit/withdrawal events via [`IEvents`] and groups them by block number.

use std::collections::BTreeMap;

use starknet_types_core::felt::Felt;

use crate::discovery::DiscoveryError;
use crate::privacy_pool::events::{IEvents, PrivacyPoolEvent};

/// On-chain deposit/withdrawal events for a single block.
///
/// Each vec is guaranteed to contain only events of the corresponding variant
/// (`PrivacyPoolEventContent::Deposit` / `::Withdrawal`).
#[derive(Debug, Clone, Default)]
pub struct BlockOnChainEvents {
    pub deposits: Vec<PrivacyPoolEvent>,
    pub withdrawals: Vec<PrivacyPoolEvent>,
}

/// Fetches on-chain Deposit and Withdrawal events for the given block numbers,
/// filtered by the user's address. Returns events grouped by block number.
pub async fn fetch_on_chain_events<E: IEvents>(
    event_access: &E,
    user_address: Felt,
    block_numbers: &[u64],
) -> Result<BTreeMap<u64, BlockOnChainEvents>, DiscoveryError> {
    if block_numbers.is_empty() {
        return Ok(BTreeMap::new());
    }

    let min_block = *block_numbers.iter().min().unwrap();
    let max_block = *block_numbers.iter().max().unwrap();

    let deposit_events = event_access
        .get_deposit_events(user_address, min_block, max_block)
        .await?;

    let withdrawal_events = event_access
        .get_withdrawal_events(user_address, min_block, max_block)
        .await?;

    let mut result: BTreeMap<u64, BlockOnChainEvents> = BTreeMap::new();

    for event in deposit_events {
        result
            .entry(event.block_number)
            .or_default()
            .deposits
            .push(event);
    }

    for event in withdrawal_events {
        result
            .entry(event.block_number)
            .or_default()
            .withdrawals
            .push(event);
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events_backend::{EmittedEvent, MockEventBackend};
    use crate::privacy_pool::events::PrivacyPoolEventContent;
    use starknet_core::utils::starknet_keccak;

    const USER_ADDR: Felt = Felt::from_hex_unchecked("0xDEAD");
    const TOKEN: Felt = Felt::from_hex_unchecked("0x1");
    const TX_HASH: Felt = Felt::from_hex_unchecked("0x999");

    fn make_raw_deposit(block_number: u64, amount: u64) -> EmittedEvent {
        EmittedEvent {
            block_number,
            transaction_hash: TX_HASH,
            keys: vec![starknet_keccak(b"Deposit"), USER_ADDR, TOKEN],
            data: vec![Felt::from(amount)],
        }
    }

    fn make_raw_withdrawal(block_number: u64, amount: u64) -> EmittedEvent {
        let to_addr = USER_ADDR; // Withdrawal filtered by to_addr = user_address
        EmittedEvent {
            block_number,
            transaction_hash: TX_HASH,
            keys: vec![starknet_keccak(b"Withdrawal"), to_addr, TOKEN],
            data: vec![Felt::ZERO, Felt::ZERO, Felt::ZERO, Felt::from(amount)],
        }
    }

    #[tokio::test]
    async fn empty_blocks_return_empty_map() {
        let backend = MockEventBackend::empty();
        let result = fetch_on_chain_events(&backend, USER_ADDR, &[])
            .await
            .unwrap();
        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn events_grouped_by_block() {
        let backend = MockEventBackend::new(vec![
            make_raw_deposit(10, 100),
            make_raw_deposit(20, 200),
            make_raw_withdrawal(10, 50),
        ]);

        let result = fetch_on_chain_events(&backend, USER_ADDR, &[10, 20])
            .await
            .unwrap();

        assert_eq!(result.len(), 2);

        let block_10 = &result[&10];
        assert_eq!(block_10.deposits.len(), 1);
        assert!(matches!(
            &block_10.deposits[0].content,
            PrivacyPoolEventContent::Deposit { amount: 100, .. }
        ));
        assert_eq!(block_10.withdrawals.len(), 1);
        assert!(matches!(
            &block_10.withdrawals[0].content,
            PrivacyPoolEventContent::Withdrawal { amount: 50, .. }
        ));

        let block_20 = &result[&20];
        assert_eq!(block_20.deposits.len(), 1);
        assert!(matches!(
            &block_20.deposits[0].content,
            PrivacyPoolEventContent::Deposit { amount: 200, .. }
        ));
        assert!(block_20.withdrawals.is_empty());
    }
}
