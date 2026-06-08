//! Source of the privacy-pool contract's storage writes, per block.
//!
//! `fetch` reconstructs the full contract storage by folding every block's
//! storage diffs (last-write-wins). State diffs are the protocol-level write
//! record, so they capture writes that emitted no event — exactly the footprint
//! we hunt for. The default implementation wraps `starknet_getStateUpdate` over
//! standard JSON-RPC, so it works against any node/provider; tests use an
//! in-memory mock.

use async_trait::async_trait;
use starknet_core::types::{BlockId, MaybePreConfirmedStateUpdate, StateUpdate};
use starknet_providers::jsonrpc::{HttpTransport, JsonRpcClient};
use starknet_providers::{Provider, ProviderError};
use starknet_types_core::felt::Felt;
use url::Url;

#[async_trait]
pub trait StateSource {
    /// Error type produced by the underlying data source.
    type Error;

    /// Returns the `(slot, value)` storage writes to the contract in `block`.
    /// A `value` of zero means the slot was cleared in that block.
    async fn storage_diffs_at(&self, block: u64) -> Result<Vec<(Felt, Felt)>, Self::Error>;
}

/// State-diff replay over standard JSON-RPC (`starknet_getStateUpdate`), the
/// default `StateSource` (DESIGN.md §4.1). Node-agnostic and immune to the
/// event-omission bug, since storage diffs are the protocol-level write record.
pub struct JsonRpcStateSource<P: Provider> {
    provider: P,
    contract: Felt,
}

impl JsonRpcStateSource<JsonRpcClient<HttpTransport>> {
    /// Builds a source over an HTTP JSON-RPC endpoint for the given contract.
    pub fn new(rpc_url: Url, contract: Felt) -> Self {
        Self {
            provider: JsonRpcClient::new(HttpTransport::new(rpc_url)),
            contract,
        }
    }
}

impl<P: Provider> JsonRpcStateSource<P> {
    /// Wraps an existing provider (e.g. a shared client) for the given contract.
    pub fn with_provider(provider: P, contract: Felt) -> Self {
        Self { provider, contract }
    }

    /// The underlying provider, so `fetch` can reuse this client for the event
    /// scan and meta reads instead of opening a second connection.
    pub fn provider(&self) -> &P {
        &self.provider
    }
}

#[async_trait]
impl<P: Provider + Sync> StateSource for JsonRpcStateSource<P> {
    type Error = ProviderError;

    async fn storage_diffs_at(&self, block: u64) -> Result<Vec<(Felt, Felt)>, ProviderError> {
        let update = self
            .provider
            .get_state_update(BlockId::Number(block))
            .await?;
        // A pinned, L1-final audit block is never pre-confirmed; treat a
        // pre-confirmed reply (no `state_diff` for a finalized block) as empty.
        let MaybePreConfirmedStateUpdate::Update(update) = update else {
            return Ok(Vec::new());
        };
        Ok(contract_storage_diffs(&update, self.contract))
    }
}

/// Extracts the `(key, value)` storage writes for `contract` from a state update.
/// Returns an empty vec if the contract had no diffs in that block.
fn contract_storage_diffs(update: &StateUpdate, contract: Felt) -> Vec<(Felt, Felt)> {
    update
        .state_diff
        .storage_diffs
        .iter()
        .filter(|diff| diff.address == contract)
        .flat_map(|diff| {
            diff.storage_entries
                .iter()
                .map(|entry| (entry.key, entry.value))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use starknet_core::types::{ContractStorageDiffItem, StateDiff, StorageEntry};

    use super::*;

    fn state_update(storage_diffs: Vec<ContractStorageDiffItem>) -> StateUpdate {
        StateUpdate {
            block_hash: Felt::ZERO,
            old_root: Felt::ZERO,
            new_root: Felt::ZERO,
            state_diff: StateDiff {
                storage_diffs,
                deprecated_declared_classes: Vec::new(),
                declared_classes: Vec::new(),
                migrated_compiled_classes: None,
                deployed_contracts: Vec::new(),
                replaced_classes: Vec::new(),
                nonces: Vec::new(),
            },
        }
    }

    fn diff(address: Felt, entries: &[(u64, u64)]) -> ContractStorageDiffItem {
        ContractStorageDiffItem {
            address,
            storage_entries: entries
                .iter()
                .map(|&(key, value)| StorageEntry {
                    key: Felt::from(key),
                    value: Felt::from(value),
                })
                .collect(),
        }
    }

    #[test]
    fn test_extracts_only_target_contract_diffs() {
        let contract = Felt::from(0xC0_u64);
        let other = Felt::from(0x99_u64);
        let update = state_update(vec![
            diff(other, &[(0x1, 100)]),
            diff(contract, &[(0xA, 10), (0xB, 20)]),
        ]);

        let mut diffs = contract_storage_diffs(&update, contract);
        diffs.sort();
        assert_eq!(
            diffs,
            vec![
                (Felt::from(0xA_u64), Felt::from(10u64)),
                (Felt::from(0xB_u64), Felt::from(20u64)),
            ]
        );
    }

    #[test]
    fn test_absent_contract_yields_empty() {
        let update = state_update(vec![diff(Felt::from(0x1_u64), &[(0xA, 10)])]);
        assert!(contract_storage_diffs(&update, Felt::from(0xC0_u64)).is_empty());
    }

    #[test]
    fn test_zero_value_writes_preserved() {
        // The fold (not this layer) interprets zero as a deletion; the source
        // must pass zero-value writes through verbatim.
        let contract = Felt::from(0xC0_u64);
        let update = state_update(vec![diff(contract, &[(0xA, 0)])]);
        assert_eq!(
            contract_storage_diffs(&update, contract),
            vec![(Felt::from(0xA_u64), Felt::ZERO)]
        );
    }
}
