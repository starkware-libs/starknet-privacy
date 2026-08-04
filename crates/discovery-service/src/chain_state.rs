//! Chain state tracking for the Starknet indexer.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use starknet_core::types::Felt;
use starknet_providers::ProviderError;
use thiserror::Error;

/// Represents the current chain head.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChainHead {
    pub block_number: u64,
    pub block_hash: Felt,
    pub timestamp: u64,
}

/// Errors that can occur during chain state operations.
#[derive(Debug, Error)]
pub enum ChainStateError {
    #[error("RPC request failed: {0}")]
    RpcError(#[source] ProviderError),
}

/// Trait for tracking chain state and verifying block canonicity.
#[async_trait]
pub trait ChainState: Send + Sync {
    /// Get the current chain head, if known.
    async fn get_head(&self) -> Option<ChainHead>;

    /// Set the current chain head.
    async fn set_head(&self, head: ChainHead);

    /// Check whether `block_hash` is the block the chain carries at its height.
    ///
    /// Canonicity is not existence: a node keeps serving an orphaned block by
    /// hash. `Err` means the node could not answer, which is neither verdict.
    async fn is_canonical(&self, block_hash: Felt) -> Result<bool, ChainStateError>;
}

#[cfg(test)]
pub mod mock {
    use super::*;

    /// Mock chain state for testing.
    pub struct MockChainState {
        head: Option<ChainHead>,
        canonical_blocks: Vec<Felt>,
    }

    impl MockChainState {
        pub fn new() -> Self {
            Self {
                head: Some(ChainHead {
                    block_number: 100,
                    block_hash: Felt::from_hex_unchecked("0x123"),
                    timestamp: 1000,
                }),
                canonical_blocks: vec![Felt::from_hex_unchecked("0x123")],
            }
        }

        pub fn with_no_head() -> Self {
            Self {
                head: None,
                canonical_blocks: vec![],
            }
        }
    }

    impl Default for MockChainState {
        fn default() -> Self {
            Self::new()
        }
    }

    #[async_trait]
    impl ChainState for MockChainState {
        async fn get_head(&self) -> Option<ChainHead> {
            self.head
        }

        async fn set_head(&self, _head: ChainHead) {
            // No-op for mock
        }

        async fn is_canonical(&self, block_hash: Felt) -> Result<bool, ChainStateError> {
            Ok(self.canonical_blocks.contains(&block_hash))
        }
    }
}
