//! High-level wrapper for spawning the discovery-service binary.

use std::time::Duration;

use anyhow::{anyhow, Result};
use nix::sys::signal::Signal;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use super::process::signal_process;

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
                let port = super::process::find_free_port()?;
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
