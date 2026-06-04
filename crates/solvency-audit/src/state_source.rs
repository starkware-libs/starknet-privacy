//! Source of the privacy-pool contract's storage writes, per block.
//!
//! `fetch` reconstructs the full contract storage by folding every block's
//! storage diffs (last-write-wins). State diffs are the protocol-level write
//! record, so they capture writes that emitted no event — exactly the footprint
//! we hunt for. The JSON-RPC implementation (a later branch) wraps
//! `starknet_getStateUpdate`; tests use an in-memory mock.

use async_trait::async_trait;
use starknet_types_core::felt::Felt;

#[async_trait]
pub trait StateSource {
    /// Error type produced by the underlying data source.
    type Error;

    /// Returns the `(slot, value)` storage writes to the contract in `block`.
    /// A `value` of zero means the slot was cleared in that block.
    async fn storage_diffs_at(&self, block: u64) -> Result<Vec<(Felt, Felt)>, Self::Error>;
}
