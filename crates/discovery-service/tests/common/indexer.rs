//! High-level wrapper for spawning the discovery-service binary.

use std::time::Duration;

use anyhow::{anyhow, Result};
use discovery_service::api::{
    ApiErrorResponse, IncomingSyncRequest, IncomingSyncResponse, OutgoingSyncRequest,
    OutgoingSyncResponse, PreflightCheckRequest, PreflightCheckResponse,
};
use nix::sys::signal::Signal;
use reqwest::StatusCode;
use serde::{de::DeserializeOwned, Serialize};
use starknet_types_core::felt::Felt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use super::devnet::DevnetClient;
use super::process::signal_process;

/// Default timeout for startup-related waits (API + subscription + reconnection).
pub const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// Default timeout for block-related waits (new block notification, shutdown, retry).
pub const DEFAULT_BLOCK_TIMEOUT: Duration = Duration::from_secs(10);

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
            .env("API_HOST", &api_host)
            .stderr(std::process::Stdio::piped());

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
        self.wait_for_logs(&["New block #"], DEFAULT_BLOCK_TIMEOUT)
            .await?;
        Ok(())
    }

    /// POST JSON to the given endpoint and return status + body text.
    async fn post_json<Req: Serialize>(
        &self,
        endpoint: &str,
        body: &Req,
    ) -> Result<(StatusCode, String)> {
        let url = format!("http://{}/{}", self.api_host, endpoint);
        let response = reqwest::Client::new().post(&url).json(body).send().await?;
        let status = response.status();
        let body_text = response.text().await?;
        Ok((status, body_text))
    }

    /// POST a sync endpoint and return the parsed success response.
    async fn sync_ok<Req: Serialize, Resp: DeserializeOwned>(
        &self,
        endpoint: &str,
        request: &Req,
    ) -> Result<Resp> {
        let (status, body) = self.post_json(endpoint, request).await?;
        if status != StatusCode::OK {
            return Err(anyhow!("Expected 200, got {}: {}", status, body));
        }
        Ok(serde_json::from_str(&body)?)
    }

    /// POST a sync endpoint and return status + parsed error body.
    async fn sync_err<Req: Serialize>(
        &self,
        endpoint: &str,
        request: &Req,
    ) -> Result<(StatusCode, ApiErrorResponse)> {
        let (status, body) = self.post_json(endpoint, request).await?;
        Ok((status, serde_json::from_str(&body)?))
    }

    /// POST `/v1/sync/incoming_state` and return the parsed success response.
    pub async fn incoming_sync(&self, req: &IncomingSyncRequest) -> Result<IncomingSyncResponse> {
        self.sync_ok("v1/sync/incoming_state", req).await
    }

    /// POST `/v1/sync/incoming_state` and return status + parsed error body.
    pub async fn incoming_sync_error(
        &self,
        req: &IncomingSyncRequest,
    ) -> Result<(StatusCode, ApiErrorResponse)> {
        self.sync_err("v1/sync/incoming_state", req).await
    }

    /// POST `/v1/sync/outgoing_state` and return the parsed success response.
    pub async fn outgoing_sync(&self, req: &OutgoingSyncRequest) -> Result<OutgoingSyncResponse> {
        self.sync_ok("v1/sync/outgoing_state", req).await
    }

    /// POST `/v1/sync/outgoing_state` and return status + parsed error body.
    pub async fn outgoing_sync_error(
        &self,
        req: &OutgoingSyncRequest,
    ) -> Result<(StatusCode, ApiErrorResponse)> {
        self.sync_err("v1/sync/outgoing_state", req).await
    }

    /// POST `/v1/sync/preflight_check` and return the parsed success response.
    pub async fn preflight_check(
        &self,
        req: &PreflightCheckRequest,
    ) -> Result<PreflightCheckResponse> {
        self.sync_ok("v1/sync/preflight_check", req).await
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
