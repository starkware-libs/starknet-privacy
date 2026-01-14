//! Unified devnet wrapper for integration tests.
//!
//! Combines features from both synchronous and async devnet wrappers:
//! - Auto port finding
//! - `load_dump_bytes()` for loading fixture state
//! - `DevnetConfig` for configuring seed, accounts, etc.
//! - Async API with `ws_url()`, `http_url()`, `create_block()`

use std::io::{Read as StdRead, Write as StdWrite};
use std::net::TcpListener;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use flate2::read::GzDecoder;
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use reqwest::Client;
use serde_json::{json, Value};
use tempfile::NamedTempFile;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone, Default)]
pub struct DevnetConfig {
    pub seed: u32,
    pub accounts: u32,
}

pub struct DevnetClient {
    process: tokio::process::Child,
    host: String,
    port: u16,
    client: Client,
    _temp_dump: Option<NamedTempFile>,
}

impl DevnetClient {
    /// Spawn devnet with on-demand block generation and auto port finding.
    pub async fn spawn(config: DevnetConfig) -> Result<Self> {
        let host = "127.0.0.1".to_string();
        let port = find_free_port()?;

        let mut process = Command::new("starknet-devnet")
            .args(["--port", &port.to_string()])
            .args(["--seed", &config.seed.to_string()])
            .args(["--accounts", &config.accounts.to_string()])
            .args(["--block-generation-on", "demand"])
            .args(["--lite-mode"])
            .args(["--state-archive-capacity", "none"])
            .args(["--l2-gas-price-fri", "1"])
            .args(["--data-gas-price-fri", "1"])
            .args(["--gas-price-fri", "1"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;

        // Wait for devnet to be ready by reading stdout
        let stdout = process.stdout.take().ok_or(anyhow!("No stdout"))?;
        let mut reader = BufReader::new(stdout).lines();

        const MAX_LINES: usize = 60;
        const LINE_READ_TIMEOUT: Duration = Duration::from_secs(3);

        for _ in 0..MAX_LINES {
            let line = tokio::time::timeout(LINE_READ_TIMEOUT, reader.next_line())
                .await
                .map_err(|_| anyhow!("Timeout waiting for devnet to start"))?
                .map_err(|e| anyhow!("Failed to read devnet output: {}", e))?
                .ok_or_else(|| anyhow!("Devnet stdout closed unexpectedly"))?;

            if line.contains("listening")
                || line.contains("Listening")
                || line.contains("Predeployed FeeToken")
            {
                // Small delay to ensure devnet is fully ready
                tokio::time::sleep(Duration::from_millis(100)).await;
                break;
            }
        }

        Ok(Self {
            process,
            host,
            port,
            client: Client::new(),
            _temp_dump: None,
        })
    }

    /// Load gzipped dump bytes via devnet_load JSON-RPC.
    pub async fn load_dump_bytes(&mut self, gz_bytes: &[u8]) -> Result<()> {
        // Decompress to temp file
        let mut temp = NamedTempFile::new()?;
        let mut decoder = GzDecoder::new(gz_bytes);
        let mut buf = Vec::new();
        decoder.read_to_end(&mut buf)?;
        temp.write_all(&buf)?;
        temp.flush()?;

        let path = temp.path().to_string_lossy().to_string();

        // Call devnet_load
        let resp: Value = self
            .client
            .post(self.rpc_url())
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "devnet_load",
                "params": { "path": path }
            }))
            .send()
            .await
            .context("Failed to send devnet_load request")?
            .json()
            .await
            .context("Failed to parse devnet_load response")?;

        if resp.get("error").is_some() {
            bail!("devnet_load failed: {resp}");
        }

        self._temp_dump = Some(temp);
        Ok(())
    }

    pub fn ws_url(&self) -> String {
        format!("ws://{}:{}/ws", self.host, self.port)
    }

    pub fn http_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    pub fn rpc_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    /// Create a new block (devnet_createBlock).
    pub async fn create_block(&self) -> Result<String> {
        let resp: Value = self.rpc("devnet_createBlock", json!({})).await?;
        resp["block_hash"]
            .as_str()
            .map(String::from)
            .ok_or(anyhow!("No block_hash in response"))
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        let rpc_url = format!("{}/rpc", self.http_url());
        let resp = self
            .client
            .post(&rpc_url)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": params
            }))
            .send()
            .await?
            .json::<Value>()
            .await?;

        if let Some(error) = resp.get("error") {
            return Err(anyhow!("RPC error: {}", error));
        }
        Ok(resp["result"].clone())
    }
}

impl Drop for DevnetClient {
    fn drop(&mut self) {
        // Kill devnet process on drop - use SIGKILL to ensure it dies
        if let Some(pid) = self.process.id() {
            let _ = kill(Pid::from_raw(pid as i32), Signal::SIGKILL);
        }
    }
}

fn find_free_port() -> Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}
