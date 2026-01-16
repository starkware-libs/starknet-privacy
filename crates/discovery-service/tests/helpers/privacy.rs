//! Privacy contract wrapper for testing.

use anyhow::{anyhow, Result};
use starknet::core::types::Felt;

use super::sncast::Sncast;

/// Privacy contract wrapper.
#[allow(unused)]
pub struct PrivacyContract {
    sncast: Sncast,
    pub address: Felt,
}

impl PrivacyContract {
    /// Declare and deploy in one step.
    pub async fn declare_and_deploy(
        sncast: Sncast,
        governance_admin: Felt,
        compliance_public_key: Felt,
    ) -> Result<Self> {
        let class_hash = sncast.declare("privacy", "Privacy").await?;
        let args = format!("{:#x}, {:#x}", governance_admin, compliance_public_key);
        let address = sncast.deploy(class_hash, Felt::ZERO, Some(&args)).await?;
        Ok(Self { sncast, address })
    }
}

/// Parse felt from sncast call output.
#[allow(dead_code)]
fn parse_felt(output: &str) -> Result<Felt> {
    // sncast call output format: response: [0x...]
    // Extract the hex value from brackets
    let start = output
        .find('[')
        .ok_or_else(|| anyhow!("No '[' in output: {}", output))?;
    let end = output
        .find(']')
        .ok_or_else(|| anyhow!("No ']' in output: {}", output))?;
    let hex = &output[start + 1..end].trim();

    Felt::from_hex(hex).map_err(|e| anyhow!("Failed to parse felt '{}': {}", hex, e))
}

/// Parse bool from sncast call output.
#[allow(dead_code)]
fn parse_bool(output: &str) -> Result<bool> {
    let trimmed = output.trim();
    // sncast call output format: response: [0x0] or response: [0x1]
    if trimmed.contains("0x1") {
        Ok(true)
    } else if trimmed.contains("0x0") {
        Ok(false)
    } else {
        anyhow::bail!("Cannot parse bool from: {}", output)
    }
}
