//! Devnet wrapper for integration tests.

use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use discovery_core::privacy_pool::types::{secret_felt_serde, SecretFelt};
use flate2::read::GzDecoder;
use nix::sys::signal::Signal;
use starknet_types_core::felt::Felt;
use tempfile::NamedTempFile;

use super::process::{find_free_port, signal_process, wait_for_log_pattern};

/// Metadata from devnet dump, written by SDK during fixture generation.
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DumpMetadata {
    pub timestamp: u64,
    pub contract_address: Felt,
    pub alice_address: Felt,
    #[serde(deserialize_with = "secret_felt_serde::deserialize")]
    pub alice_viewing_key: SecretFelt,
    pub bob_address: Felt,
    #[serde(deserialize_with = "secret_felt_serde::deserialize")]
    pub bob_viewing_key: SecretFelt,
    pub strk_token: Felt,
}

#[derive(Debug, Clone, Default)]
pub struct DevnetConfig {
    pub seed: u32,
    pub accounts: u32,
    /// Optional port to use. If None, a free port will be found automatically.
    pub port: Option<u16>,
}

pub struct DevnetClient {
    process: Child,
    port: u16,
    _temp_dump: Option<NamedTempFile>,
}

#[allow(dead_code)]
impl DevnetClient {
    pub fn spawn(config: DevnetConfig) -> Result<Self> {
        let port = config.port.unwrap_or(find_free_port()?);

        let mut process = Command::new("starknet-devnet")
            .args([
                "--lite-mode",
                "--seed",
                &config.seed.to_string(),
                "--accounts",
                &config.accounts.to_string(),
                "--port",
                &port.to_string(),
                "--block-generation-on",
                "transaction",
                "--state-archive-capacity",
                "none",
                "--l2-gas-price-fri",
                "1",
                "--data-gas-price-fri",
                "1",
                "--gas-price-fri",
                "1",
                "--proof-mode",
                "none",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("failed to spawn starknet-devnet")?;

        let stdout = process.stdout.take().expect("stdout piped");
        let patterns = ["listening on"];

        match wait_for_log_pattern(BufReader::new(stdout), &patterns, Duration::from_secs(30)) {
            Ok(_) => {
                std::thread::sleep(Duration::from_millis(100));
                Ok(Self {
                    process,
                    port,
                    _temp_dump: None,
                })
            }
            Err(e) => {
                process.kill().ok();
                Err(e.context("devnet failed to start"))
            }
        }
    }

    /// Read metadata from fixtures directory.
    fn read_metadata(fixtures_dir: &Path) -> Result<DumpMetadata> {
        let metadata_path = fixtures_dir.join("devnet-dump.metadata.json");
        let metadata: DumpMetadata = serde_json::from_str(
            &fs::read_to_string(&metadata_path)
                .with_context(|| format!("failed to read {}", metadata_path.display()))?,
        )?;
        Ok(metadata)
    }

    /// Load dump from fixtures directory.
    /// Prepends a devnet_setTime call to ensure correct block timestamps during replay.
    pub async fn load_dump(&mut self, fixtures_dir: &Path) -> Result<DumpMetadata> {
        let metadata = Self::read_metadata(fixtures_dir)?;

        let dump_path = fixtures_dir.join("devnet-dump.json.gz");
        let gz_bytes = fs::read(&dump_path)
            .with_context(|| format!("failed to read {}", dump_path.display()))?;

        // Decompress
        let mut decoder = GzDecoder::new(&gz_bytes[..]);
        let mut json_bytes = Vec::new();
        decoder.read_to_end(&mut json_bytes)?;

        // Parse as JSON array
        let mut dump: Vec<serde_json::Value> = serde_json::from_slice(&json_bytes)?;

        // Prepend devnet_setTime call
        let set_time_call = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "devnet_setTime",
            "params": { "time": metadata.timestamp }
        });
        dump.insert(0, set_time_call);

        // Write modified dump to temp file
        let mut temp = NamedTempFile::new()?;
        serde_json::to_writer(&mut temp, &dump)?;
        temp.flush()?;

        let path = temp.path().to_string_lossy().to_string();

        // Load via devnet_load
        let resp: serde_json::Value = reqwest::Client::new()
            .post(self.rpc_url())
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "devnet_load",
                "params": { "path": path }
            }))
            .send()
            .await?
            .json()
            .await?;

        if resp.get("error").is_some() {
            bail!("devnet_load failed: {resp}");
        }

        self._temp_dump = Some(temp);
        Ok(metadata)
    }

    pub fn rpc_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn ws_url(&self) -> String {
        format!("ws://127.0.0.1:{}/ws", self.port)
    }

    /// Create a new block (devnet_createBlock).
    pub async fn create_block(&self) -> Result<String> {
        let resp: serde_json::Value = reqwest::Client::new()
            .post(format!("{}/rpc", self.rpc_url()))
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "devnet_createBlock",
                "params": {}
            }))
            .send()
            .await?
            .json()
            .await?;

        if let Some(error) = resp.get("error") {
            bail!("devnet_createBlock failed: {}", error);
        }

        resp["result"]["block_hash"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| anyhow::anyhow!("No block_hash in response"))
    }
}

impl Drop for DevnetClient {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            signal_process(self.process.id(), Signal::SIGINT).ok();
        }
        self.process.kill().ok();
    }
}
