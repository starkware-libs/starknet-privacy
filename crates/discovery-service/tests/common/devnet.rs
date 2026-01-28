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
