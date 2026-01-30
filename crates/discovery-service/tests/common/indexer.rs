//! High-level wrapper for spawning the discovery-service binary.

use std::time::Duration;

use anyhow::{anyhow, Result};
use discovery_service::api_server::ApiErrorResponse;
use discovery_service::incoming_sync::{IncomingSyncRequest, IncomingSyncResponse};
use nix::sys::signal::Signal;
use reqwest::StatusCode;
use starknet_types_core::felt::Felt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use super::devnet::DevnetClient;
use super::process::signal_process;

/// Wrapper for the discovery-service binary.
#[allow(dead_code)]
pub struct IndexerClient {
    /// The process handle for the discovery-service binary.
    process: Child,
    /// A channel to receive logs from the discovery-service binary.
    log_rx: mpsc::Receiver<String>,
    /// The host:port the API server is listening on.
    api_host: String,
}

/// Configuration for spawning the indexer.
#[allow(dead_code)]
#[derive(Default)]
pub struct IndexerSpawnConfig {
    pub ws_url: String,
    pub api_port: Option<u16>,
    pub contract_address: Option<Felt>,
    pub rpc_url: Option<String>,
}

#[allow(dead_code)]
impl IndexerClient {
    pub async fn spawn(binary: &str, config: IndexerSpawnConfig) -> Result<Self> {
        let port = config
            .api_port
            .map(Ok)
            .unwrap_or_else(super::process::find_free_port)?;
        let api_host = format!("127.0.0.1:{}", port);

        let mut cmd = Command::new(binary);
        cmd.env("WS_URL", &config.ws_url)
            .arg("--api-host")
            .arg(&api_host)
            .stderr(std::process::Stdio::piped());

        if let Some(contract_addr) = config.contract_address {
            cmd.env("CONTRACT_ADDRESS", format!("{:#x}", contract_addr));
        }
        if let Some(rpc_url) = &config.rpc_url {
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

        Ok(Self {
            process,
            log_rx,
            api_host,
        })
    }

    /// The `host:port` the API server is bound to.
    pub fn api_host(&self) -> &str {
        &self.api_host
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

    /// Wait until the indexer API is ready and has processed at least one block.
    pub async fn wait_until_ready(&mut self, devnet: &DevnetClient) -> Result<()> {
        self.wait_for_log("API server listening", Duration::from_secs(10))
            .await?;
        self.wait_for_log("Subscribed to new heads", Duration::from_secs(10))
            .await?;
        devnet.create_block().await?;
        self.wait_for_log("New block #", Duration::from_secs(5))
            .await?;
        Ok(())
    }

    /// POST `/v1/discovery/incoming/sync` and return the parsed success response.
    pub async fn incoming_sync(&self, req: &IncomingSyncRequest) -> Result<IncomingSyncResponse> {
        let url = format!("http://{}/v1/discovery/incoming/sync", self.api_host);
        let resp = reqwest::Client::new().post(&url).json(req).send().await?;

        let status = resp.status();
        let body = resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("Expected 200, got {}: {}", status, body));
        }
        Ok(serde_json::from_str(&body)?)
    }

    /// POST `/v1/discovery/incoming/sync` and return status + parsed error body.
    pub async fn incoming_sync_error(
        &self,
        req: &IncomingSyncRequest,
    ) -> Result<(StatusCode, ApiErrorResponse)> {
        let url = format!("http://{}/v1/discovery/incoming/sync", self.api_host);
        let resp = reqwest::Client::new().post(&url).json(req).send().await?;

        let status = resp.status();
        let error: ApiErrorResponse = resp.json().await?;
        Ok((status, error))
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
