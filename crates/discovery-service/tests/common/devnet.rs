//! Devnet wrapper for integration tests.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use flate2::read::GzDecoder;
use starknet_types_core::felt::Felt;
use tempfile::NamedTempFile;

/// Metadata from devnet dump, written by SDK during fixture generation.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DumpMetadata {
    pub timestamp: u64,
    pub contract_address: Felt,
    pub alice_address: Felt,
    pub alice_private_key: Felt,
}

#[derive(Debug, Clone, Default)]
pub struct DevnetConfig {
    pub seed: u32,
    pub accounts: u32,
}

pub struct Devnet {
    process: Child,
    port: u16,
    _temp_dump: Option<NamedTempFile>,
}

impl Devnet {
    pub fn spawn(config: DevnetConfig) -> Result<Self> {
        let port = find_free_port()?;

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
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("failed to spawn starknet-devnet")?;

        let stdout = process.stdout.take().expect("stdout piped");
        let start = std::time::Instant::now();

        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if start.elapsed() > Duration::from_secs(30) {
                process.kill().ok();
                bail!("devnet timeout");
            }
            if line.contains("Predeployed FeeToken") || line.contains("listening on") {
                std::thread::sleep(Duration::from_millis(100));
                return Ok(Self {
                    process,
                    port,
                    _temp_dump: None,
                });
            }
        }

        process.kill().ok();
        bail!("devnet failed to start")
    }

    /// Load dump from fixtures directory using metadata file.
    /// Loads the dump state, then sets devnet time from metadata.
    /// Returns metadata containing contract and alice addresses.
    pub async fn load_dump(&mut self, fixtures_dir: &Path) -> Result<DumpMetadata> {
        let metadata_path = fixtures_dir.join("devnet-dump.metadata.json");
        let metadata: DumpMetadata = serde_json::from_str(
            &fs::read_to_string(&metadata_path)
                .with_context(|| format!("failed to read {}", metadata_path.display()))?,
        )?;

        let dump_path = fixtures_dir.join("devnet-dump.json.gz");
        let gz_bytes = fs::read(&dump_path)
            .with_context(|| format!("failed to read {}", dump_path.display()))?;

        self.set_time(metadata.timestamp).await?;
        self.load_dump_bytes(&gz_bytes).await?;

        Ok(metadata)
    }

    /// Set devnet block timestamp via devnet_setTime JSON-RPC.
    async fn set_time(&self, timestamp: u64) -> Result<()> {
        let resp: serde_json::Value = reqwest::Client::new()
            .post(self.rpc_url())
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "devnet_setTime",
                "params": { "time": timestamp }
            }))
            .send()
            .await?
            .json()
            .await?;

        if resp.get("error").is_some() {
            bail!("devnet_setTime failed: {resp}");
        }
        Ok(())
    }

    /// Load gzipped dump bytes via devnet_load JSON-RPC.
    async fn load_dump_bytes(&mut self, gz_bytes: &[u8]) -> Result<()> {
        // Decompress to temp file
        let mut temp = NamedTempFile::new()?;
        let mut decoder = GzDecoder::new(gz_bytes);
        let mut buf = Vec::new();
        decoder.read_to_end(&mut buf)?;
        temp.write_all(&buf)?;
        temp.flush()?;

        let path = temp.path().to_string_lossy().to_string();

        // Call devnet_load
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
        Ok(())
    }

    pub fn rpc_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for Devnet {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(self.process.id() as i32, libc::SIGINT);
        }
        self.process.kill().ok();
    }
}

fn find_free_port() -> Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}
