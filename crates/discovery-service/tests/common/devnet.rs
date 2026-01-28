//! Devnet wrapper for integration tests.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use flate2::read::GzDecoder;
use starknet_core::types::Felt;
use starknet_core::utils::starknet_keccak;
use tempfile::NamedTempFile;

/// Predeployed account from devnet.
#[derive(Debug, Clone)]
pub struct PredeployedAccount {
    pub address: Felt,
    pub private_key: Felt,
    pub public_key: Felt,
}

/// Contract deployed via UDC.
#[derive(Debug, Clone)]
pub struct DeployedContract {
    pub address: Felt,
    pub deployer: Felt,
    pub class_hash: Felt,
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

    /// Get predeployed accounts from devnet.
    pub async fn get_predeployed_accounts(&self) -> Result<Vec<PredeployedAccount>> {
        #[derive(serde::Deserialize)]
        struct RawAccount {
            address: String,
            private_key: String,
            public_key: String,
        }

        let resp: serde_json::Value = reqwest::Client::new()
            .post(self.rpc_url())
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "devnet_getPredeployedAccounts",
                "params": {}
            }))
            .send()
            .await?
            .json()
            .await?;

        if let Some(err) = resp.get("error") {
            bail!("devnet_getPredeployedAccounts failed: {err}");
        }

        let raw: Vec<RawAccount> = serde_json::from_value(
            resp.get("result")
                .context("missing result")?
                .clone(),
        )?;

        raw.into_iter()
            .map(|a| Ok(PredeployedAccount {
                address: Felt::from_hex(&a.address)?,
                private_key: Felt::from_hex(&a.private_key)?,
                public_key: Felt::from_hex(&a.public_key)?,
            }))
            .collect()
    }

    /// Get all contracts deployed via UDC.
    /// Searches for ContractDeployed events from any address.
    pub async fn get_deployed_contracts(&self) -> Result<Vec<DeployedContract>> {
        let selector = starknet_keccak(b"ContractDeployed");

        let resp: serde_json::Value = reqwest::Client::new()
            .post(self.rpc_url())
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "starknet_getEvents",
                "params": {
                    "filter": {
                        "from_block": { "block_number": 0 },
                        "to_block": "latest",
                        "keys": [[format!("{selector:#x}")]],
                        "chunk_size": 100
                    }
                }
            }))
            .send()
            .await?
            .json()
            .await?;

        if let Some(err) = resp.get("error") {
            bail!("starknet_getEvents failed: {err}");
        }

        let events = resp
            .get("result")
            .and_then(|r| r.get("events"))
            .and_then(|e| e.as_array())
            .context("missing events")?;

        // UDC ContractDeployed event:
        // keys: [selector]
        // data: [address, deployer, unique, class_hash, calldata_len, ...calldata]
        let mut contracts = Vec::new();
        for event in events {
            let data = event.get("data").and_then(|d| d.as_array());
            if let Some(data) = data {
                if data.len() >= 4 {
                    let address = Felt::from_hex(data[0].as_str().unwrap_or("0x0"))?;
                    let deployer = Felt::from_hex(data[1].as_str().unwrap_or("0x0"))?;
                    let class_hash = Felt::from_hex(data[3].as_str().unwrap_or("0x0"))?;
                    contracts.push(DeployedContract { address, deployer, class_hash });
                }
            }
        }

        Ok(contracts)
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
