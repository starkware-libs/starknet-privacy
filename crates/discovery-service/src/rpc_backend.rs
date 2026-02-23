//! RPC-based implementation of the storage interface and chain state.

use std::sync::Arc;

use async_trait::async_trait;
use discovery_core::storage_backend::{
    RawStorageAccess, StorageBackend, StorageError, StorageSnapshot,
};
use starknet_core::types::{requests::GetStorageAtRequest, BlockId, BlockTag, Felt, StarknetError};
use starknet_providers::{
    jsonrpc::{HttpTransport, JsonRpcClient},
    Provider, ProviderError, ProviderRequestData, ProviderResponseData,
};
use thiserror::Error;
use tokio::sync::RwLock;
use tower::limit::concurrency::ConcurrencyLimitLayer;
use url::Url;

use crate::chain_state::{ChainHead, ChainState, ChainStateError};
use crate::config::RpcConfig;

/// Errors specific to the RPC backend.
#[derive(Debug, Error)]
pub enum RpcBackendError {
    /// Failed to build the HTTP client.
    #[error("failed to build HTTP client: {0}")]
    HttpClientBuild(#[source] reqwest::Error),
    /// Invalid RPC URL.
    #[error("invalid RPC URL: {0}")]
    InvalidUrl(#[source] url::ParseError),
    /// RPC request failed.
    #[error("RPC request failed: {0}")]
    Request(String),
    /// Unexpected response type from batch request.
    #[error("unexpected response type from batch request")]
    UnexpectedResponseType,
}

impl From<RpcBackendError> for StorageError {
    fn from(err: RpcBackendError) -> Self {
        StorageError::Backend(Box::new(err))
    }
}

/// Inner state shared across clones of RpcBackend.
struct RpcBackendInner {
    provider: JsonRpcClient<HttpTransport>,
    head: RwLock<Option<ChainHead>>,
    max_batch_size: usize,
}

/// RPC-based storage backend that reads from a StarkNet node via JSON-RPC.
///
/// This backend is cheaply cloneable and uses a connection pool with
/// configurable concurrency limits. Cloned instances share the same
/// underlying connection pool and concurrency limiter.
#[derive(Clone)]
pub struct RpcBackend {
    inner: Arc<RpcBackendInner>,
}

impl RpcBackend {
    /// Creates a new RPC backend with the given configuration.
    pub fn new(config: RpcConfig) -> Result<Self, RpcBackendError> {
        let rpc_url = Url::parse(&config.url).map_err(RpcBackendError::InvalidUrl)?;

        let client = reqwest::Client::builder()
            .connect_timeout(config.connect_timeout)
            .timeout(config.request_timeout)
            .pool_max_idle_per_host(config.max_idle_per_host)
            .connector_layer(ConcurrencyLimitLayer::new(config.max_concurrent_requests))
            .build()
            .map_err(RpcBackendError::HttpClientBuild)?;

        let transport = HttpTransport::new_with_client(rpc_url, client);
        let provider = JsonRpcClient::new(transport);

        Ok(Self {
            inner: Arc::new(RpcBackendInner {
                provider,
                head: RwLock::new(None),
                max_batch_size: config.max_batch_size,
            }),
        })
    }
}

#[async_trait]
impl StorageBackend for RpcBackend {
    type Snapshot = RpcSnapshot;

    async fn snapshot(&self, contract_address: Felt, block_id: Option<BlockId>) -> Self::Snapshot {
        let block_id = block_id.unwrap_or(BlockId::Tag(BlockTag::Latest));
        RpcSnapshot {
            backend: self.clone(),
            contract_address,
            block_id,
        }
    }
}

/// Snapshot of storage at a specific block, accessed via RPC.
#[derive(Clone)]
pub struct RpcSnapshot {
    backend: RpcBackend,
    contract_address: Felt,
    block_id: BlockId,
}

impl RpcSnapshot {
    /// Executes a single JSON-RPC batch request for the given slots.
    async fn batch_read(&self, slots: &[Felt]) -> Result<Vec<Felt>, StorageError> {
        let contract_address = self.contract_address;

        let requests: Vec<ProviderRequestData> = slots
            .iter()
            .map(|&slot| {
                ProviderRequestData::GetStorageAt(GetStorageAtRequest {
                    contract_address,
                    key: slot,
                    block_id: self.block_id,
                })
            })
            .collect();

        let responses = self
            .backend
            .inner
            .provider
            .batch_requests(&requests)
            .await
            .map_err(|e| RpcBackendError::Request(e.to_string()))?;

        responses
            .into_iter()
            .map(|resp| match resp {
                ProviderResponseData::GetStorageAt(value) => Ok(value),
                _ => Err(RpcBackendError::UnexpectedResponseType.into()),
            })
            .collect()
    }
}

#[async_trait]
impl RawStorageAccess for RpcSnapshot {
    async fn read_slot(&self, slot: Felt) -> Result<Felt, StorageError> {
        self.backend
            .inner
            .provider
            .get_storage_at(self.contract_address, slot, self.block_id)
            .await
            .map_err(|e| RpcBackendError::Request(e.to_string()).into())
    }

    async fn read_slots(&self, slots: Vec<Felt>) -> Result<Vec<Felt>, StorageError> {
        if slots.is_empty() {
            return Ok(vec![]);
        }
        if slots.len() == 1 {
            return Ok(vec![self.read_slot(slots[0]).await?]);
        }

        let mut results = Vec::with_capacity(slots.len());
        // TODO: consider provessing chunks concurrently
        for chunk in slots.chunks(self.backend.inner.max_batch_size) {
            let chunk_results = self.batch_read(chunk).await?;
            results.extend(chunk_results);
        }
        Ok(results)
    }
}

#[async_trait]
impl ChainState for RpcBackend {
    async fn get_head(&self) -> Option<ChainHead> {
        *self.inner.head.read().await
    }

    async fn set_head(&self, head: ChainHead) {
        *self.inner.head.write().await = Some(head);
    }

    async fn is_canonical(&self, block_hash: Felt) -> Result<bool, ChainStateError> {
        match self
            .inner
            .provider
            .get_block_transaction_count(BlockId::Hash(block_hash))
            .await
        {
            Ok(_) => Ok(true),
            Err(ProviderError::StarknetError(StarknetError::BlockNotFound)) => Ok(false),
            Err(e) => Err(ChainStateError::RpcError(e)),
        }
    }
}

#[async_trait]
impl StorageSnapshot for RpcSnapshot {
    fn block_id(&self) -> BlockId {
        self.block_id
    }
}
