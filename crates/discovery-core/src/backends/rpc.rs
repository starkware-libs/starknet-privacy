//! RPC-based implementation of the storage interface.

use std::sync::Arc;

use async_trait::async_trait;
use starknet_core::types::{requests::GetStorageAtRequest, BlockId, BlockTag, Felt};
use starknet_providers::{
    jsonrpc::{HttpTransport, JsonRpcClient},
    Provider, ProviderRequestData, ProviderResponseData,
};
use url::Url;

use crate::storage::{RawStorageAccess, StorageBackend, StorageError, StorageSnapshot};

/// Configuration for the RPC backend.
#[derive(Debug, Clone)]
pub struct RpcConfig {
    /// URL of the StarkNet JSON-RPC endpoint.
    pub rpc_url: Url,
    /// Address of the privacy contract to read from.
    pub contract_address: Felt,
}

/// RPC-based storage backend that reads from a StarkNet node via JSON-RPC.
pub struct RpcBackend {
    provider: Arc<JsonRpcClient<HttpTransport>>,
    contract_address: Felt,
}

impl RpcBackend {
    /// Creates a new RPC backend with the given configuration.
    pub fn new(config: RpcConfig) -> Self {
        let transport = HttpTransport::new(config.rpc_url);
        let provider = Arc::new(JsonRpcClient::new(transport));
        Self {
            provider,
            contract_address: config.contract_address,
        }
    }
}

#[async_trait]
impl StorageBackend for RpcBackend {
    type Snapshot = RpcSnapshot;

    async fn snapshot(&self, block_id: Option<BlockId>) -> Result<Self::Snapshot, StorageError> {
        let block_id = block_id.unwrap_or(BlockId::Tag(BlockTag::Latest));
        Ok(RpcSnapshot {
            provider: Arc::clone(&self.provider),
            contract_address: self.contract_address,
            block_id,
        })
    }
}

/// Snapshot of storage at a specific block, accessed via RPC.
pub struct RpcSnapshot {
    provider: Arc<JsonRpcClient<HttpTransport>>,
    contract_address: Felt,
    block_id: BlockId,
}

#[async_trait]
impl RawStorageAccess for RpcSnapshot {
    async fn read_slot(&self, slot: Felt) -> Result<Felt, StorageError> {
        self.provider
            .get_storage_at(self.contract_address, slot, self.block_id)
            .await
            .map_err(|e| StorageError::Rpc(e.to_string()))
    }

    async fn read_slots(&self, slots: Vec<Felt>) -> Result<Vec<Felt>, StorageError> {
        if slots.is_empty() {
            return Ok(vec![]);
        }
        if slots.len() == 1 {
            return Ok(vec![self.read_slot(slots[0]).await?]);
        }

        // Build batch request
        let requests: Vec<ProviderRequestData> = slots
            .iter()
            .map(|&slot| {
                ProviderRequestData::GetStorageAt(GetStorageAtRequest {
                    contract_address: self.contract_address,
                    key: slot,
                    block_id: self.block_id,
                })
            })
            .collect();

        // Execute batch
        let responses = self
            .provider
            .batch_requests(&requests)
            .await
            .map_err(|e| StorageError::Rpc(e.to_string()))?;

        // Extract results
        responses
            .into_iter()
            .map(|resp| match resp {
                ProviderResponseData::GetStorageAt(value) => Ok(value),
                _ => Err(StorageError::Rpc("Unexpected response type".into())),
            })
            .collect()
    }
}

#[async_trait]
impl StorageSnapshot for RpcSnapshot {
    fn block_id(&self) -> BlockId {
        self.block_id
    }
}
