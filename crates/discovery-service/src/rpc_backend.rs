//! RPC-based implementation of the storage interface and chain state.

use std::sync::Arc;

use async_trait::async_trait;
use discovery_core::events_backend::RawEventAccess;
use discovery_core::storage_backend::{
    RawStorageAccess, StorageBackend, StorageError, StorageSnapshot,
};
use starknet_core::types::{
    requests::GetStorageAtRequest, AddressFilter, BlockId, BlockTag, EmittedEvent, EventFilter,
    Felt, GetStorageAtResult, MaybePreConfirmedBlockWithTxHashes, StarknetError, StorageKey,
    StorageResponseFlag, StorageResult,
};
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
    event_page_size: usize,
    /// Maximum allowed block range for a single `get_events` query.
    /// `0` means unlimited.
    max_event_block_range: u64,
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
                event_page_size: config.event_page_size,
                max_event_block_range: config.max_event_block_range,
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
    /// Builds and sends a batch `get_storage_at` request for the given slots,
    /// optionally including response flags (e.g. `IncludeLastUpdateBlock`).
    async fn send_batch_storage_request(
        &self,
        slots: &[Felt],
        response_flags: Option<Vec<StorageResponseFlag>>,
    ) -> Result<Vec<ProviderResponseData>, StorageError> {
        let contract_address = self.contract_address;

        let requests: Vec<ProviderRequestData> = slots
            .iter()
            .map(|&slot| {
                ProviderRequestData::GetStorageAt(GetStorageAtRequest {
                    contract_address,
                    key: StorageKey(format!("{slot:#x}")),
                    block_id: self.block_id,
                    response_flags: response_flags.clone(),
                })
            })
            .collect();

        self.backend
            .inner
            .provider
            .batch_requests(&requests)
            .await
            .map_err(|e| match &e {
                ProviderError::StarknetError(StarknetError::ContractNotFound) => {
                    StorageError::ContractNotFound
                }
                _ => StorageError::from(RpcBackendError::Request(e.to_string())),
            })
    }

    /// Executes a batch `get_storage_at` request (values only).
    async fn batch_read(&self, slots: &[Felt]) -> Result<Vec<Felt>, StorageError> {
        self.send_batch_storage_request(slots, None)
            .await?
            .into_iter()
            .map(|resp| match resp {
                ProviderResponseData::GetStorageAt(result) => Ok(result.value()),
                _ => Err(RpcBackendError::UnexpectedResponseType.into()),
            })
            .collect()
    }

    /// Executes a batch `get_storage_at` request with `IncludeLastUpdateBlock` flag.
    async fn batch_read_with_block(
        &self,
        slots: &[Felt],
    ) -> Result<Vec<StorageResult>, StorageError> {
        let flags = vec![StorageResponseFlag::IncludeLastUpdateBlock];
        self.send_batch_storage_request(slots, Some(flags))
            .await?
            .into_iter()
            .map(|resp| match resp {
                ProviderResponseData::GetStorageAt(GetStorageAtResult::ValueWithMetadata(
                    result,
                )) => Ok(result),
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
            .get_storage_at(self.contract_address, slot, self.block_id, None)
            .await
            .map(|result| result.value())
            .map_err(|e| match &e {
                ProviderError::StarknetError(StarknetError::ContractNotFound) => {
                    StorageError::ContractNotFound
                }
                _ => RpcBackendError::Request(e.to_string()).into(),
            })
    }

    async fn read_slots(&self, slots: Vec<Felt>) -> Result<Vec<Felt>, StorageError> {
        if slots.is_empty() {
            return Ok(vec![]);
        }
        if slots.len() == 1 {
            return Ok(vec![self.read_slot(slots[0]).await?]);
        }

        let mut results = Vec::with_capacity(slots.len());
        for chunk in slots.chunks(self.backend.inner.max_batch_size) {
            let chunk_results = self.batch_read(chunk).await?;
            results.extend(chunk_results);
        }
        Ok(results)
    }

    async fn read_slots_with_block(
        &self,
        slots: Vec<Felt>,
    ) -> Result<Vec<StorageResult>, StorageError> {
        if slots.is_empty() {
            return Ok(vec![]);
        }

        let mut results = Vec::with_capacity(slots.len());
        for chunk in slots.chunks(self.backend.inner.max_batch_size) {
            let chunk_results = self.batch_read_with_block(chunk).await?;
            results.extend(chunk_results);
        }
        Ok(results)
    }
}

#[async_trait]
impl RawEventAccess for RpcSnapshot {
    async fn get_events(
        &self,
        keys: &[Vec<Felt>],
        from_block: u64,
        to_block: u64,
    ) -> Result<Vec<EmittedEvent>, StorageError> {
        let max_range = self.backend.inner.max_event_block_range;
        if max_range > 0 {
            let range = to_block.saturating_sub(from_block).saturating_add(1);
            if range > max_range {
                return Err(RpcBackendError::Request(format!(
                    "event query block range {range} exceeds maximum {max_range}"
                ))
                .into());
            }
        }

        // Strip trailing empty key vecs — they mean "wildcard" in our trait but
        // some RPC implementations (e.g. devnet) treat them as "match nothing".
        let trimmed_keys: Vec<Vec<Felt>> = {
            let end = keys
                .iter()
                .rposition(|v| !v.is_empty())
                .map_or(0, |i| i + 1);
            keys[..end].to_vec()
        };

        let filter = EventFilter {
            from_block: Some(BlockId::Number(from_block)),
            to_block: Some(BlockId::Number(to_block)),
            address: Some(AddressFilter::Single(self.contract_address)),
            keys: if trimmed_keys.is_empty() {
                None
            } else {
                Some(trimmed_keys)
            },
        };

        let mut all_events = Vec::new();
        let mut continuation_token = None;

        loop {
            let page = self
                .backend
                .inner
                .provider
                .get_events(
                    filter.clone(),
                    continuation_token,
                    self.backend.inner.event_page_size as u64,
                )
                .await
                .map_err(|e| RpcBackendError::Request(e.to_string()))?;

            all_events.reserve(page.events.len());
            all_events.extend(page.events);

            match page.continuation_token {
                Some(token) => continuation_token = Some(token),
                None => break,
            }
        }

        Ok(all_events)
    }
}

#[async_trait]
impl ChainState for RpcBackend {
    async fn get_head(&self) -> Option<ChainHead> {
        if let Some(head) = *self.inner.head.read().await {
            return Some(head);
        }

        // Fallback: fetch latest block via RPC when WS subscription hasn't
        // provided a head yet (e.g. WS not available on the node).
        let block = self
            .inner
            .provider
            .get_block_with_tx_hashes(BlockId::Tag(BlockTag::Latest))
            .await
            .ok()?;

        match block {
            MaybePreConfirmedBlockWithTxHashes::Block(head) => Some(ChainHead {
                block_number: head.block_number,
                block_hash: head.block_hash,
                timestamp: head.timestamp,
            }),
            MaybePreConfirmedBlockWithTxHashes::PreConfirmedBlock(_) => None,
        }
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
    fn contract_address(&self) -> Felt {
        self.contract_address
    }

    fn block_id(&self) -> BlockId {
        self.block_id
    }
}
