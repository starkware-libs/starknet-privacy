//! RPC-based implementation of the storage interface and chain state.
//!
// TODO: Implement batched "deferred" requests to seamlessly provide
// parallelization for discovery operations (e.g. note fetch + nullifier
// check can be issued as a single batched RPC call).

use std::sync::Arc;
use std::time::Duration;

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

/// Errors specific to the RPC backend.
#[derive(Debug, Error)]
pub enum RpcBackendError {
    /// Failed to build the HTTP client.
    #[error("failed to build HTTP client: {0}")]
    HttpClientBuild(#[source] reqwest::Error),
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

/// Configuration for the connection pool.
#[derive(Debug, Clone)]
pub struct PoolConfig {
    /// Maximum number of concurrent RPC requests.
    pub max_concurrent_requests: usize,
    /// Connection timeout in seconds.
    pub connect_timeout_secs: u64,
    /// Request timeout in seconds.
    pub request_timeout_secs: u64,
    /// Maximum idle connections per host.
    pub pool_max_idle_per_host: usize,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            max_concurrent_requests: 10,
            connect_timeout_secs: 30,
            request_timeout_secs: 60,
            pool_max_idle_per_host: 10,
        }
    }
}

const DEFAULT_RPC_URL: &str = "http://127.0.0.1:5050";

/// Configuration for the RPC backend.
#[derive(Debug, Clone)]
pub struct RpcConfig {
    /// URL of the StarkNet JSON-RPC endpoint.
    pub rpc_url: Url,
    /// Address of the privacy contract to read from.
    pub contract_address: Felt,
    /// Connection pool configuration.
    pub pool_config: PoolConfig,
}

impl RpcConfig {
    /// Creates a new RPC configuration with the given URL and contract address.
    pub fn new(rpc_url: Url, contract_address: Felt) -> Self {
        Self {
            rpc_url,
            contract_address,
            pool_config: PoolConfig::default(),
        }
    }
}

impl Default for RpcConfig {
    fn default() -> Self {
        Self {
            rpc_url: Url::parse(DEFAULT_RPC_URL).unwrap(),
            contract_address: Felt::ZERO,
            pool_config: PoolConfig::default(),
        }
    }
}

/// Inner state shared across clones of RpcBackend.
struct RpcBackendInner {
    provider: JsonRpcClient<HttpTransport>,
    contract_address: Felt,
    head: RwLock<Option<ChainHead>>,
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
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(config.pool_config.connect_timeout_secs))
            .timeout(Duration::from_secs(config.pool_config.request_timeout_secs))
            .pool_max_idle_per_host(config.pool_config.pool_max_idle_per_host)
            .connector_layer(ConcurrencyLimitLayer::new(
                config.pool_config.max_concurrent_requests,
            ))
            .build()
            .map_err(RpcBackendError::HttpClientBuild)?;

        let transport = HttpTransport::new_with_client(config.rpc_url, client);
        let provider = JsonRpcClient::new(transport);

        Ok(Self {
            inner: Arc::new(RpcBackendInner {
                provider,
                contract_address: config.contract_address,
                head: RwLock::new(None),
            }),
        })
    }
}

#[async_trait]
impl StorageBackend for RpcBackend {
    type Snapshot = RpcSnapshot;

    async fn snapshot(&self, block_id: Option<BlockId>) -> Result<Self::Snapshot, StorageError> {
        let block_id = block_id.unwrap_or(BlockId::Tag(BlockTag::Latest));
        Ok(RpcSnapshot {
            backend: self.clone(),
            block_id,
        })
    }
}

/// Snapshot of storage at a specific block, accessed via RPC.
#[derive(Clone)]
pub struct RpcSnapshot {
    backend: RpcBackend,
    block_id: BlockId,
}

#[async_trait]
impl RawStorageAccess for RpcSnapshot {
    async fn read_slot(&self, slot: Felt) -> Result<Felt, StorageError> {
        self.backend
            .inner
            .provider
            .get_storage_at(self.backend.inner.contract_address, slot, self.block_id)
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

        let contract_address = self.backend.inner.contract_address;

        // Build batch request
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

        // Execute batch
        let responses = self
            .backend
            .inner
            .provider
            .batch_requests(&requests)
            .await
            .map_err(|e| RpcBackendError::Request(e.to_string()))?;

        // Extract results
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
