//! High-level wrapper for spawning the discovery-service binary.

use std::time::Duration;

use anyhow::{anyhow, Result};
use nix::sys::signal::Signal;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use super::devnet::DevnetClient;
use super::process::{find_free_port, signal_process};

/// Default timeout for startup-related waits (API + subscription + reconnection).
pub const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// Default timeout for block-related waits (new block notification, shutdown, retry).
pub const DEFAULT_BLOCK_TIMEOUT: Duration = Duration::from_secs(10);

/// Wrapper for the discovery-service binary.
pub struct IndexerClient {
    /// The process handle for the discovery-service binary.
    process: Child,
    /// A channel to receive logs from the discovery-service binary.
    log_rx: mpsc::Receiver<String>,
}

impl IndexerClient {
    pub async fn spawn_with_binary(
        binary: &str,
        ws_url: &str,
        api_host: Option<&str>,
    ) -> Result<Self> {
        let auto_port;
        let api_host = match api_host {
            Some(h) => h,
            None => {
                let port = find_free_port()?;
                auto_port = format!("127.0.0.1:{}", port);
                &auto_port
            }
        };

        let mut process = Command::new(binary)
            .env("WS_URL", ws_url)
            .arg("--api-host")
            .arg(api_host)
            .stderr(std::process::Stdio::piped())
            .spawn()?;

        let stderr = process.stderr.take().ok_or(anyhow!("No stderr"))?;
        let (log_tx, log_rx) = mpsc::channel(100);

        // Spawn task to read logs
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = log_tx.send(line).await;
            }
        });

        Ok(Self { process, log_rx })
    }

    /// Wait for a specific log message.
    pub async fn wait_for_log(&mut self, pattern: &str, timeout: Duration) -> Result<String> {
        self.wait_for_logs(&[pattern], timeout)
            .await
            .map(|v| v.into_values().next().unwrap())
    }

    /// Wait for all given patterns to appear in logs (in any order).
    pub async fn wait_for_logs(
        &mut self,
        patterns: &[&str],
        timeout: Duration,
    ) -> Result<std::collections::HashMap<String, String>> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut found: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        while found.len() < patterns.len() {
            match tokio::time::timeout_at(deadline, self.log_rx.recv()).await {
                Ok(Some(line)) => {
                    eprintln!("LOG: {}", line);
                    for &p in patterns {
                        if !found.contains_key(p) && line.contains(p) {
                            found.insert(p.to_string(), line.clone());
                        }
                    }
                }
                _ => break,
            }
        }
        if found.len() == patterns.len() {
            Ok(found)
        } else {
            let missing: Vec<&str> = patterns
                .iter()
                .copied()
                .filter(|p| !found.contains_key(*p))
                .collect();
            Err(anyhow!("Timeout waiting for: {}", missing.join(", ")))
        }
    }

    /// Wait for the indexer to be fully ready: API listening, subscribed, and
    /// processing blocks.
    pub async fn wait_until_ready(&mut self, devnet: &DevnetClient) -> Result<()> {
        self.wait_for_logs(
            &["API server listening", "Subscribed to new heads"],
            DEFAULT_STARTUP_TIMEOUT,
        )
        .await?;
        devnet.create_block().await?;
        self.wait_for_log("New block #", DEFAULT_BLOCK_TIMEOUT)
            .await?;
        Ok(())
    }

    /// Send SIGINT for graceful shutdown.
    pub fn signal_shutdown(&self) -> Result<()> {
        let pid = self.process.id().ok_or(anyhow!("No pid"))?;
        signal_process(pid, Signal::SIGINT)
    }

    pub async fn wait(mut self) -> Result<std::process::ExitStatus> {
        Ok(self.process.wait().await?)
    }
}
