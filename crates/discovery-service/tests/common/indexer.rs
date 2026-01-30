//! High-level wrapper for spawning the discovery-service binary.

use std::time::Duration;

use anyhow::{anyhow, Result};
use nix::sys::signal::Signal;
use starknet_types_core::felt::Felt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use super::process::signal_process;

/// Wrapper for the discovery-service binary.
#[allow(dead_code)]
pub struct IndexerClient {
    /// The process handle for the discovery-service binary.
    process: Child,
    /// A channel to receive logs from the discovery-service binary.
    log_rx: mpsc::Receiver<String>,
}

/// Configuration for spawning the indexer.
#[allow(dead_code)]
#[derive(Default)]
pub struct IndexerSpawnConfig<'a> {
    pub ws_url: &'a str,
    pub api_host: Option<&'a str>,
    pub contract_address: Option<Felt>,
    pub rpc_url: Option<&'a str>,
}

#[allow(dead_code)]
impl IndexerClient {
    pub async fn spawn_with_binary(
        binary: &str,
        ws_url: &str,
        api_host: Option<&str>,
    ) -> Result<Self> {
        Self::spawn_with_config(
            binary,
            IndexerSpawnConfig {
                ws_url,
                api_host,
                ..Default::default()
            },
        )
        .await
    }

    pub async fn spawn_with_config(binary: &str, config: IndexerSpawnConfig<'_>) -> Result<Self> {
        let auto_port;
        let api_host = match config.api_host {
            Some(h) => h,
            None => {
                let port = super::process::find_free_port()?;
                auto_port = format!("127.0.0.1:{}", port);
                &auto_port
            }
        };

        let mut cmd = Command::new(binary);
        cmd.env("WS_URL", config.ws_url)
            .arg("--api-host")
            .arg(api_host)
            .stderr(std::process::Stdio::piped());

        if let Some(contract_addr) = config.contract_address {
            cmd.env("CONTRACT_ADDRESS", format!("{:#x}", contract_addr));
        }
        if let Some(rpc_url) = config.rpc_url {
            cmd.env("RPC_URL", rpc_url);
        }

        let mut process = cmd.spawn()?;

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
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout_at(deadline, self.log_rx.recv()).await {
                Ok(Some(line)) => {
                    eprintln!("LOG: {}", line);
                    if line.contains(pattern) {
                        return Ok(line);
                    }
                }
                _ => break,
            }
        }
        Err(anyhow!("Timeout waiting for: {}", pattern))
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
