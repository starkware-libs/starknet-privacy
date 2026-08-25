//! Graceful shutdown helper.

use thiserror::Error;
use tokio::{
    signal::unix::{signal, SignalKind},
    sync::broadcast,
};
use tracing::info;

/// Errors that can occur while waiting to broadcast a shutdown.
#[derive(Debug, Error)]
pub enum ShutdownError {
    /// A signal handler could not be registered, so the process cannot observe SIGTERM or SIGINT.
    #[error("failed to register signal handler: {0}")]
    SignalHandler(#[from] std::io::Error),
    /// The signal arrived but every subscriber had already dropped its receiver.
    #[error("no subscriber left to notify")]
    NoSubscribers,
}

/// Manages graceful shutdown by listening for SIGTERM and SIGINT signals
/// and broadcasting shutdown notifications to subscribers.
pub struct Shutdown {
    tx_shutdown: broadcast::Sender<()>,
}

impl Default for Shutdown {
    fn default() -> Self {
        let (tx_shutdown, _) = broadcast::channel(1);
        Self { tx_shutdown }
    }
}

impl Shutdown {
    #[allow(dead_code)]
    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.tx_shutdown.subscribe()
    }

    pub async fn run(&self) -> Result<(), ShutdownError> {
        let mut sigterm = signal(SignalKind::terminate())?;
        let mut sigint = signal(SignalKind::interrupt())?;

        tokio::select! {
            _ = sigterm.recv() => info!("Received SIGTERM, initiating shutdown..."),
            _ = sigint.recv() => info!("Received SIGINT, initiating shutdown..."),
        };

        self.notify()
    }

    /// Broadcasts the shutdown notification. Separate from the signal wait so both outcomes are
    /// reachable in a test.
    fn notify(&self) -> Result<(), ShutdownError> {
        self.tx_shutdown
            .send(())
            .map(|_| ())
            .map_err(|_| ShutdownError::NoSubscribers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notify_reaches_a_subscriber() {
        let shutdown = Shutdown::default();
        let mut receiver = shutdown.subscribe();

        shutdown.notify().expect("a live subscriber accepts it");

        assert!(receiver.try_recv().is_ok());
    }

    #[test]
    fn notify_reports_that_nobody_is_listening() {
        let shutdown = Shutdown::default();
        drop(shutdown.subscribe());

        let error = shutdown.notify().expect_err("nobody is left to receive");

        assert!(matches!(error, ShutdownError::NoSubscribers));
    }
}
