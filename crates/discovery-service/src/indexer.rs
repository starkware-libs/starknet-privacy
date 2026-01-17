//! Indexer that subscribes to Starknet new heads via WebSocket and indexes state diffs.

use std::time::Duration;

use backoff::ExponentialBackoffBuilder;
use backoff::{backoff::Backoff, ExponentialBackoff};
use starknet::core::types::{
    BlockHeader, BlockId, BlockTag, ConfirmedBlockId, Felt, MaybePreConfirmedBlockWithTxHashes,
    MaybePreConfirmedStateUpdate,
};
use starknet::providers::jsonrpc::HttpTransport;
use starknet::providers::{JsonRpcClient, Provider};
use starknet_tokio_tungstenite::{NewHeadsUpdate, TungsteniteStream};
use thiserror::Error;
use tokio::sync::broadcast;
use tracing::{debug, error, info, warn};
use url::Url;

use crate::store::{IndexedState, SqliteStore, Store, StoreError};

const DEFAULT_WS_URL: &str = "ws://127.0.0.1:5050/ws";
const DEFAULT_RPC_URL: &str = "http://127.0.0.1:5050/rpc";
const DEFAULT_DB_PATH: &str = "data/discovery.db";

/// Errors that can occur during indexer operation.
#[derive(Debug, Error)]
pub enum IndexerError {
    /// WebSocket connection error (retriable).
    #[error("WebSocket connection error: {0}")]
    Connect(#[from] starknet_tokio_tungstenite::ConnectError),
    /// WebSocket subscription error (retriable).
    #[error("WebSocket subscription error: {0}")]
    Subscribe(#[from] starknet_tokio_tungstenite::SubscribeError),
    /// Error receiving subscription updates (retriable).
    #[error("Subscription receive error: {0}")]
    Receive(#[from] starknet_tokio_tungstenite::SubscriptionReceiveError),
    /// Error unsubscribing from updates.
    #[error("Unsubscribe error: {0}")]
    Unsubscribe(#[from] starknet_tokio_tungstenite::UnsubscribeError),
    /// Error closing WebSocket connection.
    #[error("WebSocket close error: {0}")]
    Close(#[from] starknet_tokio_tungstenite::CloseError),
    /// RPC provider error (retriable).
    #[error("RPC error: {0}")]
    Rpc(#[from] starknet::providers::ProviderError),
    /// Unexpected response from provider (retriable).
    #[error("Unexpected response: {0}")]
    UnexpectedResponse(String),
    /// Storage error (fatal).
    #[error("Storage error: {0}")]
    Store(#[from] StoreError),
}

impl IndexerError {
    /// Returns true if this error is retriable.
    fn is_retriable(&self) -> bool {
        matches!(
            self,
            IndexerError::Connect(_)
                | IndexerError::Subscribe(_)
                | IndexerError::Receive(_)
                | IndexerError::Unsubscribe(_)
                | IndexerError::Close(_)
                | IndexerError::Rpc(_)
                | IndexerError::UnexpectedResponse(_)
        )
    }
}

pub struct IndexerConfig {
    pub ws_url: String,
    pub rpc_url: String,
    pub db_path: String,
    pub contract_address: Felt,
    pub starting_block: Option<(u64, Felt)>,
    pub connect_timeout: Duration,
    pub backoff_initial_interval: Duration,
    pub backoff_max_interval: Duration,
    pub backoff_max_elapsed_time: Option<Duration>,
}

impl Default for IndexerConfig {
    fn default() -> Self {
        Self {
            ws_url: DEFAULT_WS_URL.to_string(),
            rpc_url: DEFAULT_RPC_URL.to_string(),
            db_path: DEFAULT_DB_PATH.to_string(),
            contract_address: Felt::ZERO,
            starting_block: None,
            connect_timeout: Duration::from_secs(10),
            backoff_initial_interval: Duration::from_secs(1),
            backoff_max_interval: Duration::from_secs(60),
            backoff_max_elapsed_time: None,
        }
    }
}

pub struct Indexer {
    config: IndexerConfig,
    backoff: ExponentialBackoff,
    rx_shutdown: broadcast::Receiver<()>,
    rpc_client: JsonRpcClient<HttpTransport>,
}

impl Indexer {
    pub fn new(config: IndexerConfig, rx_shutdown: broadcast::Receiver<()>) -> Self {
        let backoff = ExponentialBackoffBuilder::default()
            .with_initial_interval(config.backoff_initial_interval)
            .with_max_interval(config.backoff_max_interval)
            .with_max_elapsed_time(config.backoff_max_elapsed_time)
            .build();

        let rpc_url = Url::parse(&config.rpc_url).expect("Invalid RPC URL");
        let rpc_client = JsonRpcClient::new(HttpTransport::new(rpc_url));

        Self {
            config,
            backoff,
            rx_shutdown,
            rpc_client,
        }
    }

    /// Outer loop: handles reconnection with exponential backoff.
    pub async fn run(&mut self) -> Result<(), ()> {
        info!("Indexer started");
        info!("Indexing contract: {:#066x}", self.config.contract_address);

        info!("Opening database at {}", self.config.db_path);
        let store = match SqliteStore::writer(&self.config.db_path).await {
            Ok(store) => store,
            Err(e) => {
                error!("Failed to open database: {}", e);
                return Err(());
            }
        };
        info!("Database opened");

        loop {
            match self.run_inner(&store).await {
                Ok(()) => {
                    info!("Indexer terminated");
                    return Ok(());
                }
                Err(e) if e.is_retriable() => {
                    warn!("Indexer error: {}, will retry", e);
                    if let Some(delay) = self.backoff.next_backoff() {
                        info!("Reconnecting in {:?}", delay);
                        tokio::select! {
                            _ = tokio::time::sleep(delay) => {}
                            _ = self.rx_shutdown.recv() => {
                                info!("Shutdown signal received");
                                return Ok(());
                            }
                        }
                    }
                }
                Err(e) => {
                    error!("Indexer fatal error: {}", e);
                    return Err(());
                }
            }
        }
    }

    /// Inner loop: backfill to chain head, then process websocket updates.
    async fn run_inner(&mut self, store: &SqliteStore) -> Result<(), IndexerError> {
        if self.rx_shutdown.try_recv().is_ok() {
            return Ok(());
        }

        // Phase 1: Backfill to chain head
        let chain_head = self.fetch_chain_head().await?;
        self.index_to_head(store, chain_head).await?;
        info!("Backfill complete, switching to websocket mode");

        // Phase 2: Connect websocket and process new heads
        info!("Connecting to {}", self.config.ws_url);
        let stream =
            TungsteniteStream::connect(&self.config.ws_url, self.config.connect_timeout).await?;
        info!("WebSocket connection established");

        let mut subscription = stream.subscribe_new_heads(ConfirmedBlockId::Latest).await?;
        info!("Subscribed to new heads");

        self.backoff.reset();

        loop {
            tokio::select! {
                update = subscription.recv() => {
                    match update? {
                        NewHeadsUpdate::NewHeader(head) => {
                            info!("New block #{}: {:#066x}", head.block_number, head.block_hash);

                            // Store block + update chain head
                            self.update_chain_head(store, &head).await?;

                            // Index state diffs to new head
                            self.index_to_head(store, head.block_number).await?;
                        }
                        NewHeadsUpdate::Reorg(reorg) => {
                            warn!(
                                "Reorg detected: #{} -> #{}",
                                reorg.starting_block_number, reorg.ending_block_number
                            );
                            // TODO: Handle reorg
                            // - Delete blocks from starting_block_number
                            // - Delete storage_diffs from starting_block_number
                            // - Reset indexed state to block before reorg
                        }
                    }
                }

                _ = self.rx_shutdown.recv() => {
                    let _ = subscription.unsubscribe().await;
                    info!("Unsubscribed from new heads");
                    let _ = stream.close().await;
                    info!("Closed WebSocket connection");
                    return Ok(());
                }
            }
        }
    }

    /// Update chain head in database and cache new block.
    async fn update_chain_head(
        &self,
        store: &SqliteStore,
        block_header: &BlockHeader,
    ) -> Result<(), IndexerError> {
        let mut tx = store.begin().await?;
        tx.store_block(block_header.block_number, block_header.block_hash)
            .await?;
        tx.set_head(
            block_header.block_number,
            block_header.block_hash,
            block_header.timestamp,
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    /// Fetch current chain head via RPC.
    async fn fetch_chain_head(&self) -> Result<u64, IndexerError> {
        info!(
            "Fetching remote chain head via RPC at {}",
            self.config.rpc_url
        );
        let latest = self
            .rpc_client
            .get_block_with_tx_hashes(BlockId::Tag(BlockTag::Latest))
            .await?;

        let height = match latest {
            MaybePreConfirmedBlockWithTxHashes::Block(b) => b.block_number,
            MaybePreConfirmedBlockWithTxHashes::PreConfirmedBlock(_) => {
                return Err(IndexerError::UnexpectedResponse(
                    "Latest block is pre-confirmed".to_string(),
                ));
            }
        };
        info!("Remote chain head: block #{}", height);
        Ok(height)
    }

    /// Load indexed state with priority: DB > config > genesis RPC.
    async fn load_indexed_state(&self, store: &SqliteStore) -> Result<IndexedState, IndexerError> {
        // Check DB first (read-only, no transaction needed)
        let db_state = {
            let mut conn = store.acquire().await?;
            conn.get_indexed_state().await?
        };

        if let Some(state) = db_state {
            debug!(
                "Resuming from indexed state: block #{} ({:#066x})",
                state.block_height, state.block_hash
            );
            return Ok(state);
        }

        // Determine initial state: config > genesis RPC
        let initial_state = if let Some((height, hash)) = self.config.starting_block {
            info!(
                "Using configured starting block: #{} ({:#066x})",
                height, hash
            );
            IndexedState {
                block_height: height,
                block_hash: hash,
            }
        } else {
            info!("No starting block configured, fetching genesis block via RPC");
            let genesis = self
                .rpc_client
                .get_block_with_tx_hashes(BlockId::Number(0))
                .await?;

            let block_hash = match genesis {
                MaybePreConfirmedBlockWithTxHashes::Block(b) => b.block_hash,
                MaybePreConfirmedBlockWithTxHashes::PreConfirmedBlock(_) => {
                    return Err(IndexerError::UnexpectedResponse(
                        "Genesis block is pre-confirmed".to_string(),
                    ));
                }
            };
            info!("Genesis block hash: {:#066x}", block_hash);
            IndexedState {
                block_height: 0,
                block_hash,
            }
        };

        // Persist initial state
        let mut tx = store.begin().await?;
        tx.set_indexed_state(initial_state.block_height, initial_state.block_hash)
            .await?;
        tx.commit().await?;

        Ok(initial_state)
    }

    /// Index state diffs from current indexed state to target height.
    async fn index_to_head(&self, store: &SqliteStore, target: u64) -> Result<(), IndexerError> {
        let current = self.load_indexed_state(store).await?;

        if current.block_height > target {
            // TODO: Handle reorg - indexed state is ahead of chain head
            // Need to rollback indexed state and storage_diffs to target
            warn!(
                "Indexed state #{} is ahead of target #{}, possible reorg (unhandled)",
                current.block_height, target
            );
            return Ok(());
        }

        if current.block_height == target {
            info!("Already indexed to block #{}", target);
            return Ok(());
        }

        let from = current.block_height + 1;
        info!(
            "Indexing {} blocks: #{} to #{}",
            target - from + 1,
            from,
            target
        );
        for height in from..=target {
            self.index_block(store, height).await?;
        }
        info!("Finished indexing to block #{}", target);
        Ok(())
    }

    /// Index a single block's state diffs.
    async fn index_block(&self, store: &SqliteStore, height: u64) -> Result<(), IndexerError> {
        debug!("Fetching state update for block #{}", height);

        let state_update = self
            .rpc_client
            .get_state_update(BlockId::Number(height))
            .await?;

        let state_update = match state_update {
            MaybePreConfirmedStateUpdate::Update(su) => su,
            MaybePreConfirmedStateUpdate::PreConfirmedUpdate(_) => {
                debug!("Block #{} is pre-confirmed, skipping", height);
                return Ok(());
            }
        };

        // Filter storage diffs for contract_address
        let entries: Vec<(Felt, Felt)> = state_update
            .state_diff
            .storage_diffs
            .iter()
            .filter(|d| d.address == self.config.contract_address)
            .flat_map(|d| d.storage_entries.iter().map(|e| (e.key, e.value)))
            .collect();

        // Batch insert + update indexed state atomically
        let mut tx = store.begin().await?;
        if !entries.is_empty() {
            debug!(
                "Block #{}: inserting {} storage entries",
                height,
                entries.len()
            );
            tx.batch_insert_storage_diffs(height, &entries).await?;
        }
        tx.set_indexed_state(height, state_update.block_hash)
            .await?;
        tx.commit().await?;

        if entries.is_empty() {
            debug!(
                "Indexed block #{} (no storage changes for target contract)",
                height
            );
        } else {
            info!(
                "Indexed block #{}: {} storage entries ({:#066x})",
                height,
                entries.len(),
                state_update.block_hash
            );
        }

        Ok(())
    }
}
