//! High-level wrapper for spawning and controlling starknet-devnet.

use std::time::Duration;

use anyhow::{anyhow, Result};
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tracing::info;

#[derive(Debug, Clone, Deserialize)]
pub struct PredeployedAccount {
    pub address: String,
    pub private_key: String,
    pub public_key: String,
}

/// Block generation mode for devnet.
///
/// See: <https://0xspaceshard.github.io/starknet-devnet/docs/blocks>
#[derive(Debug, Clone, Copy, Default)]
pub enum BlockGeneration {
    /// Blocks are created on-demand via `create_block()` RPC call.
    /// Transactions are stored in a pre-confirmed block until manually mined.
    #[default]
    Demand,
    /// Blocks are created automatically on each transaction (devnet default).
    Transaction,
}

/// Wrapper for starknet-devnet binary and an RPC client.
pub struct DevnetClient {
    /// The process handle for starknet-devnet.
    process: tokio::process::Child,
    /// The host on which starknet-devnet is listening.
    host: String,
    /// The port on which starknet-devnet is listening.
    port: u16,
    /// The client for making HTTP requests to starknet-devnet.
    client: Client,
}

impl DevnetClient {
    /// Spawn devnet with on-demand block generation.
    /// Use `create_block()` to mine blocks manually.
    pub async fn spawn() -> Result<Self> {
        Self::spawn_with_config(BlockGeneration::Demand).await
    }

    /// Spawn devnet with automatic block generation on each transaction.
    /// Blocks are mined automatically, no need to call `create_block()`.
    pub async fn spawn_auto_mine() -> Result<Self> {
        Self::spawn_with_config(BlockGeneration::Transaction).await
    }

    /// Spawn devnet with specified block generation mode.
    async fn spawn_with_config(block_generation: BlockGeneration) -> Result<Self> {
        let host = "127.0.0.1".to_string();
        let port = 5050u16;

        let block_mode = match block_generation {
            BlockGeneration::Demand => "demand",
            BlockGeneration::Transaction => "transaction",
        };

        let mut process = Command::new("starknet-devnet")
            .args(["--port", &port.to_string()])
            .args(["--block-generation-on", block_mode])
            .args(["--state-archive-capacity", "full"]) // required for abort_blocks
            .args(["--accounts", "3"]) // alice, bob, charlie
            .stderr(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()?;

        // Wait for devnet to be ready by reading stdout (that's where logs go)
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

            info!("devnet: {}", line);
            if line.contains("listening") || line.contains("Listening") {
                break;
            }
        }

        Ok(Self {
            process,
            host,
            port,
            client: Client::new(),
        })
    }

    pub fn ws_url(&self) -> String {
        format!("ws://{}:{}/ws", self.host, self.port)
    }

    pub fn http_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    /// Fetch predeployed accounts from devnet.
    pub async fn get_predeployed_accounts(&self) -> Result<Vec<PredeployedAccount>> {
        let resp: Value = self.rpc("devnet_getPredeployedAccounts", json!({})).await?;
        let accounts: Vec<PredeployedAccount> = serde_json::from_value(resp)?;
        Ok(accounts)
    }

    /// Create a new block (devnet_createBlock).
    pub async fn create_block(&self) -> Result<String> {
        let resp: Value = self.rpc("devnet_createBlock", json!({})).await?;
        resp["block_hash"]
            .as_str()
            .map(String::from)
            .ok_or(anyhow!("No block_hash in response"))
    }

    /// Abort blocks to simulate reorg (devnet_abortBlocks).
    pub async fn abort_blocks(&self, starting_block_hash: &str) -> Result<Vec<String>> {
        let resp: Value = self
            .rpc(
                "devnet_abortBlocks",
                json!({
                    "starting_block_id": {
                        "block_hash": starting_block_hash
                    }
                }),
            )
            .await?;
        Ok(resp["aborted"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default())
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
