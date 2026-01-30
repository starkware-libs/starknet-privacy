//! Indexer that subscribes to Starknet new heads via WebSocket.

use std::time::Duration;

use backoff::ExponentialBackoffBuilder;
use backoff::{backoff::Backoff, ExponentialBackoff};
use starknet::core::types::ConfirmedBlockId;
use starknet_tokio_tungstenite::{NewHeadsUpdate, TungsteniteStream};
use thiserror::Error;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

use crate::chain_state::{ChainHead, ChainState};

const DEFAULT_WS_URL: &str = "ws://127.0.0.1:5050/ws";

/// Errors that can occur during indexer operation.
#[derive(Debug, Error)]
pub enum IndexerError {
    /// WebSocket connection error.
    #[error("WebSocket connection error: {0}")]
    WebSocketConnect(#[from] starknet_tokio_tungstenite::ConnectError),
    /// WebSocket subscription error.
    #[error("WebSocket subscription error: {0}")]
    WebSocketSubscribe(#[from] starknet_tokio_tungstenite::SubscribeError),
    /// Error receiving subscription updates.
    #[error("Subscription receive error: {0}")]
    WebSocketReceive(#[from] starknet_tokio_tungstenite::SubscriptionReceiveError),
    /// Error unsubscribing from updates.
    #[error("Unsubscribe error: {0}")]
    WebSocketUnsubscribe(#[from] starknet_tokio_tungstenite::UnsubscribeError),
    /// Error closing WebSocket connection.
    #[error("WebSocket close error: {0}")]
    WebSocketClose(#[from] starknet_tokio_tungstenite::CloseError),
}

impl IndexerError {
    /// Returns `true` if this error is recoverable and the indexer should retry.
    ///
    /// Recoverable errors are transient connection issues that may succeed on retry:
    /// - `WebSocketConnect`: Failed to establish connection (server may be down temporarily)
    /// - `WebSocketSubscribe`: Failed to subscribe (connection may have been interrupted)
    /// - `WebSocketReceive`: Failed to receive message (connection may have dropped)
    ///
    /// Non-recoverable errors occur during graceful shutdown and should not be retried:
    /// - `WebSocketUnsubscribe`: Failed during cleanup
    /// - `WebSocketClose`: Failed during cleanup
    pub fn is_recoverable(&self) -> bool {
        matches!(
            self,
            IndexerError::WebSocketConnect(_)
                | IndexerError::WebSocketSubscribe(_)
                | IndexerError::WebSocketReceive(_)
        )
    }
}

pub struct IndexerConfig {
    pub ws_url: String,
    pub connect_timeout: Duration,
    pub backoff_initial_interval: Duration,
    pub backoff_max_interval: Duration,
    pub backoff_max_elapsed_time: Option<Duration>,
}

impl Default for IndexerConfig {
    fn default() -> Self {
        Self {
            ws_url: DEFAULT_WS_URL.to_string(),
            connect_timeout: Duration::from_secs(10),
            backoff_initial_interval: Duration::from_secs(1),
            backoff_max_interval: Duration::from_secs(60),
            backoff_max_elapsed_time: None,
        }
    }
}

/// Indexer that subscribes to Starknet new heads via WebSocket.
pub struct Indexer<C: ChainState> {
    config: IndexerConfig,
    backoff: ExponentialBackoff,
    rx_shutdown: broadcast::Receiver<()>,
    chain_state: C,
}

impl<C: ChainState> Indexer<C> {
    /// Creates a new indexer with the given configuration, shutdown receiver, and chain state.
    pub fn new(
        config: IndexerConfig,
        rx_shutdown: broadcast::Receiver<()>,
        chain_state: C,
    ) -> Self {
        let backoff = ExponentialBackoffBuilder::default()
            .with_initial_interval(config.backoff_initial_interval)
            .with_max_interval(config.backoff_max_interval)
            .with_max_elapsed_time(config.backoff_max_elapsed_time)
            .build();
        Self {
            config,
            backoff,
            rx_shutdown,
            chain_state,
        }
    }

    /// Outer loop: handles reconnection with exponential backoff.
    ///
    /// Only recoverable errors (connection, subscription, receive) trigger a retry.
    /// Non-recoverable errors (unsubscribe, close) cause immediate failure.
    pub async fn run(&mut self) -> Result<(), ()> {
        info!("Indexer started");

        loop {
            match self.run_inner().await {
                Ok(()) => {
                    info!("Indexer terminated");
                    return Ok(());
                }
                Err(e) if e.is_recoverable() => {
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
                    error!("Indexer error (non-recoverable): {}", e);
                    return Err(());
                }
            }
        }
    }

    /// Inner loop: connects, subscribes, processes messages until error or shutdown.
    async fn run_inner(&mut self) -> Result<(), IndexerError> {
        // Check for shutdown before connecting
        if self.rx_shutdown.try_recv().is_ok() {
            return Ok(());
        }

        info!("Connecting to {}", self.config.ws_url);
        let stream =
            TungsteniteStream::connect(&self.config.ws_url, self.config.connect_timeout).await?;
        info!("WebSocket connection established");

        let mut subscription = stream.subscribe_new_heads(ConfirmedBlockId::Latest).await?;
        info!("Subscribed to new heads");

        // Reset backoff after successful connection
        self.backoff.reset();

        loop {
            tokio::select! {
                update = subscription.recv() => {
                    match update? {
                        NewHeadsUpdate::NewHeader(head) => {
                            info!("New block #{}: {:#064x}", head.block_number, head.block_hash);
                            self.chain_state.set_head(ChainHead {
                                block_number: head.block_number,
                                block_hash: head.block_hash,
                                timestamp: head.timestamp,
                            }).await;
                        }
                        NewHeadsUpdate::Reorg(reorg) => {
                            warn!(
                                "Reorg detected: #{} -> #{}",
                                reorg.starting_block_number, reorg.ending_block_number
                            );
                        }
                    }
                }
                _ = self.rx_shutdown.recv() => {
                    subscription.unsubscribe().await?;
                    info!("Unsubscribed from new heads");
                    stream.close().await?;
                    info!("Closed WebSocket connection");
                    return Ok(());
                }
            }
        }
    }
}
