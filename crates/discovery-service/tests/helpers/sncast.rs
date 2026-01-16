//! Generic wrapper for sncast CLI commands.

use std::path::PathBuf;

use anyhow::{anyhow, Result};
use serde_json::json;
use starknet::core::types::Felt;
use tokio::process::Command;

use super::devnet::PredeployedAccount;

/// Generic sncast CLI wrapper.
pub struct Sncast {
    url: String,
    accounts_file: PathBuf,
    account: String,
    working_dir: PathBuf,
}

impl Sncast {
    /// Create Sncast configured for devnet.
    pub async fn for_devnet(
        devnet_url: &str,
        working_dir: PathBuf,
        accounts: &[PredeployedAccount],
        account_index: usize,
    ) -> Result<Self> {
        let accounts_file = working_dir.join("accounts.json");
        generate_accounts_file(accounts, &accounts_file)?;

        Ok(Self {
            url: format!("{}/rpc", devnet_url),
            accounts_file,
            account: format!("devnet{}", account_index),
            working_dir,
        })
    }

    /// Execute sncast command and return stdout.
    /// Note: sncast requires global options before subcommand, then subcommand-specific options.
    async fn run(&self, subcommand: &str, args: &[&str]) -> Result<String> {
        let output = Command::new("sncast")
            .args(["--accounts-file", self.accounts_file.to_str().unwrap()])
            .args(["--account", &self.account])
            .arg(subcommand)
            .args(["--url", &self.url])
            .args(args)
            .current_dir(&self.working_dir)
            .output()
            .await?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let combined = format!("{}\n{}", stdout, stderr);

        // Check for errors in output (sncast sometimes returns 0 even on failure)
        if !output.status.success() || combined.contains("Error:") {
            anyhow::bail!("sncast {} failed:\n{}", subcommand, combined);
        }

        Ok(combined)
    }

    /// Declare a contract.
    /// Returns the class hash.
    pub async fn declare(&self, package: &str, contract_name: &str) -> Result<Felt> {
        let output = self
            .run(
                "declare",
                &["--package", package, "--contract-name", contract_name],
            )
            .await?;
        extract_felt(&output, "Class Hash")
    }

    /// Deploy a contract.
    /// Returns the contract address.
    pub async fn deploy(
        &self,
        class_hash: Felt,
        salt: Felt,
        arguments: Option<&str>,
    ) -> Result<Felt> {
        let class_hash_str = format!("{:#x}", class_hash);
        let salt_str = format!("{:#x}", salt);

        let mut args = vec!["--class-hash", &class_hash_str, "--salt", &salt_str];

        if let Some(args_str) = arguments {
            args.push("--arguments");
            args.push(args_str);
        }

        let output = self.run("deploy", &args).await?;
        extract_felt(&output, "Contract Address")
    }

    /// Invoke a contract function.
    /// Returns the transaction hash.
    #[allow(dead_code)]
    pub async fn invoke(
        &self,
        contract_address: Felt,
        function: &str,
        calldata: Option<&str>,
    ) -> Result<Felt> {
        let addr_str = format!("{:#x}", contract_address);

        let mut args = vec!["--contract-address", &addr_str, "--function", function];

        if let Some(data) = calldata {
            args.push("--calldata");
            args.push(data);
        }

        let output = self.run("invoke", &args).await?;
        extract_felt(&output, "Transaction Hash")
    }

    /// Call a contract function (read-only).
    /// Returns the output of the function.
    #[allow(dead_code)]
    pub async fn call(
        &self,
        contract_address: Felt,
        function: &str,
        calldata: Option<&str>,
    ) -> Result<String> {
        let addr_str = format!("{:#x}", contract_address);

        let mut args = vec!["--contract-address", &addr_str, "--function", function];

        if let Some(data) = calldata {
            args.push("--calldata");
            args.push(data);
        }

        self.run("call", &args).await
    }
}

/// Extract felt from sncast call output.
fn extract_felt(output: &str, key: &str) -> Result<Felt> {
    for line in output.lines() {
        if line.contains(key) {
            if let Some(hex) = line.split(':').nth(1) {
                return Felt::from_hex(hex.trim())
                    .map_err(|e| anyhow!("Failed to parse {}: {}", key, e));
            }
        }
    }
    anyhow::bail!("{} not found in output:\n{}", key, output)
}

/// Generate accounts.json file for sncast from predeployed accounts.
fn generate_accounts_file(accounts: &[PredeployedAccount], path: &PathBuf) -> Result<()> {
    let mut devnet_accounts = serde_json::Map::new();

    for (i, acc) in accounts.iter().enumerate() {
        devnet_accounts.insert(
            format!("devnet{}", i),
            json!({
                "address": &acc.address,
                "private_key": &acc.private_key,
                "public_key": &acc.public_key,
                "deployed": true,
                "legacy": false,
                "type": "open_zeppelin"
            }),
        );
    }

    let accounts_json = json!({
        "alpha-sepolia": devnet_accounts
    });

    std::fs::write(path, serde_json::to_string_pretty(&accounts_json)?)?;
    Ok(())
}
