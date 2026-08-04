//! Indexer that subscribes to Starknet new heads via WebSocket.

use backoff::ExponentialBackoffBuilder;
use backoff::{backoff::Backoff, ExponentialBackoff};
use starknet_core::types::ConfirmedBlockId;
use starknet_tokio_tungstenite::{NewHeadsUpdate, TungsteniteStream};
use thiserror::Error;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

use crate::chain_state::{ChainHead, ChainState};
use crate::config::IndexerConfig;

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
            let outcome = self.run_inner().await;
            if outcome.is_err() {
                // On loss, not on reconnect: a reconnect may be many backoff intervals
                // away, and nothing notifies about the gap.
                self.chain_state.forget_recent_blocks().await;
            }
            match outcome {
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
                            self.chain_state.record_reorg(&reorg).await;
                        }
                    }
                }
                _ = self.rx_shutdown.recv() => {
                    if let Err(err) = subscription.unsubscribe().await {
                        error!(%err, "Failed to unsubscribe during shutdown");
                    } else {
                        info!("Unsubscribed from new heads");
                    }
                    if let Err(err) = stream.close().await {
                        error!(%err, "Failed to close WebSocket during shutdown");
                    } else {
                        info!("Closed WebSocket connection");
                    }
                    return Ok(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use async_trait::async_trait;
    use starknet_core::types::{Felt, ReorgData};

    use super::*;
    use crate::chain_state::{ChainStateError, RecentBlockWindow};

    /// Keeps a real [`RecentBlockWindow`] and counts forget calls, so a test can
    /// assert on the window's verdicts rather than only on the calls.
    #[derive(Clone, Default)]
    struct RecordingChainState {
        recent_blocks: Arc<Mutex<RecentBlockWindow>>,
        num_forget_calls: Arc<AtomicUsize>,
    }

    impl RecordingChainState {
        fn canonicity(&self, block_hash: Felt) -> Option<bool> {
            self.recent_blocks
                .lock()
                .expect("recent blocks lock")
                .canonicity(block_hash)
        }

        fn num_forget_calls(&self) -> usize {
            self.num_forget_calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl ChainState for RecordingChainState {
        async fn get_head(&self) -> Option<ChainHead> {
            None
        }

        async fn set_head(&self, head: ChainHead) {
            self.recent_blocks
                .lock()
                .expect("recent blocks lock")
                .record_head(&head);
        }

        async fn record_reorg(&self, reorg: &ReorgData) {
            self.recent_blocks
                .lock()
                .expect("recent blocks lock")
                .record_reorg(reorg);
        }

        async fn forget_recent_blocks(&self) {
            self.num_forget_calls.fetch_add(1, Ordering::SeqCst);
            self.recent_blocks
                .lock()
                .expect("recent blocks lock")
                .clear();
        }

        async fn is_canonical(&self, _block_hash: Felt) -> Result<bool, ChainStateError> {
            unreachable!("the indexer never asks about canonicity")
        }
    }

    /// Losing the stream must drop what it announced straight away; deferring to a
    /// successful reconnect would answer the whole outage out of stale memory.
    #[tokio::test]
    async fn test_lost_subscription_forgets_announced_blocks_before_reconnecting() {
        let announced_hash = Felt::from_hex_unchecked("0xabc");
        let chain_state = RecordingChainState::default();
        chain_state
            .set_head(ChainHead {
                block_number: 100,
                block_hash: announced_hash,
                timestamp: 1_700_000_000,
            })
            .await;
        assert_eq!(
            chain_state.canonicity(announced_hash),
            Some(true),
            "the announced head starts out covered by the window"
        );

        let (tx_shutdown, rx_shutdown) = broadcast::channel(1);
        let mut indexer = Indexer::new(
            IndexerConfig {
                // Nothing listening, so the connect fails at once.
                ws_url: "ws://127.0.0.1:1/ws".to_string(),
                connect_timeout: Duration::from_secs(1),
                // Long enough that the assertions below can only pass if the window
                // was cleared on the failure rather than on a reconnect.
                backoff_initial_interval: Duration::from_secs(600),
                backoff_max_interval: Duration::from_secs(600),
                backoff_max_elapsed_time: None,
            },
            rx_shutdown,
            chain_state.clone(),
        );
        let indexer_task = tokio::spawn(async move { indexer.run().await });

        tokio::time::timeout(Duration::from_secs(10), async {
            while chain_state.num_forget_calls() == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("a failed connect must forget the announced blocks");

        assert_eq!(
            chain_state.canonicity(announced_hash),
            None,
            "a hash announced by a dead subscription must go back to the node"
        );

        tx_shutdown.send(()).expect("shutdown receiver is alive");
        indexer_task
            .await
            .expect("indexer task panicked")
            .expect("shutdown during backoff is a clean exit");
    }
}
