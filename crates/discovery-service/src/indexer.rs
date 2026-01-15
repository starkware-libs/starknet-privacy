//! Indexer that subscribes to Starknet new heads via WebSocket.

use std::time::Duration;

use anyhow::{Context, Result};
use backoff::ExponentialBackoffBuilder;
use backoff::{backoff::Backoff, ExponentialBackoff};
use starknet::core::types::ConfirmedBlockId;
use starknet_tokio_tungstenite::{NewHeadsUpdate, TungsteniteStream};
use tokio::sync::broadcast;
use tracing::{error, info, warn};

use crate::store::{SqliteStore, Store};

const DEFAULT_WS_URL: &str = "ws://127.0.0.1:5050/ws";
const DEFAULT_DB_PATH: &str = "data/discovery.db";

pub struct IndexerConfig {
    pub ws_url: String,
    pub db_path: String,
    pub connect_timeout: Duration,
    pub backoff_initial_interval: Duration,
    pub backoff_max_interval: Duration,
    pub backoff_max_elapsed_time: Option<Duration>,
}

impl Default for IndexerConfig {
    fn default() -> Self {
        Self {
            ws_url: DEFAULT_WS_URL.to_string(),
            db_path: DEFAULT_DB_PATH.to_string(),
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
}

#[derive(thiserror::Error, Debug)]
enum IndexerError {
    #[error("Retriable indexer error: {0}")]
    Retriable(#[source] anyhow::Error),
    #[error("Fatal indexer error: {0}")]
    Fatal(#[from] anyhow::Error),
}

impl Indexer {
    pub fn new(config: IndexerConfig, rx_shutdown: broadcast::Receiver<()>) -> Self {
        let backoff = ExponentialBackoffBuilder::default()
            .with_initial_interval(config.backoff_initial_interval)
            .with_max_interval(config.backoff_max_interval)
            .with_max_elapsed_time(config.backoff_max_elapsed_time)
            .build();
        Self {
            config,
            backoff,
            rx_shutdown,
        }
    }

    /// Outer loop: handles reconnection with exponential backoff.
    pub async fn run(&mut self) -> Result<(), ()> {
        info!("Indexer started");

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
                Err(IndexerError::Retriable(e)) => {
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
                Err(IndexerError::Fatal(e)) => {
                    error!("Indexer fatal error: {}", e);
                    return Err(());
                }
            }
        }
    }

    /// Inner loop: connects, subscribes, processes messages until error or shutdown.
    async fn run_inner(&mut self, store: &SqliteStore) -> Result<(), IndexerError> {
        // Check for shutdown before connecting
        if self.rx_shutdown.try_recv().is_ok() {
            return Ok(());
        }

        info!("Connecting to {}", self.config.ws_url);
        let stream = TungsteniteStream::connect(&self.config.ws_url, self.config.connect_timeout)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to connect to websocket: {}", e))
            .map_err(IndexerError::Retriable)?;
        info!("WebSocket connection established");

        let mut subscription = stream
            .subscribe_new_heads(ConfirmedBlockId::Latest)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to subscribe to new heads: {}", e))?;
        info!("Subscribed to new heads");

        // Reset backoff after successful connection
        self.backoff.reset();

        loop {
            tokio::select! {
                update = subscription.recv() => {
                    let update = update
                        .context("Failed to receive new heads update")
                        .map_err(IndexerError::Retriable)?;
                    match update {
                        NewHeadsUpdate::NewHeader(head) => {
                            info!("New block #{}: {:#064x}", head.block_number, head.block_hash);
                            let mut tx = store.begin().await?;
                            tx.store_block(head.block_number, head.block_hash).await?;
                            tx.set_head(head.block_number, head.block_hash, head.timestamp).await?;
                            tx.commit().await?;
                        }
                        NewHeadsUpdate::Reorg(reorg) => {
                            warn!(
                                "Reorg detected: #{} -> #{}",
                                reorg.starting_block_number, reorg.ending_block_number
                            );
                            // TODO: Implement reorg handling - delete blocks and entries >= starting_block_number
                        }
                    }
                }
                _ = self.rx_shutdown.recv() => {
                    subscription
                        .unsubscribe()
                        .await
                        .map_err(|e| anyhow::anyhow!("Failed to unsubscribe from new heads: {}", e))?;
                    info!("Unsubscribed from new heads");
                    stream
                        .close()
                        .await
                        .map_err(|e| anyhow::anyhow!("Failed to close websocket: {}", e))?;
                    info!("Closed WebSocket connection");
                    return Ok(());
                }
            }
        }
    }
}
