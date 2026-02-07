//! Configuration loading with TOML file support and env var overrides.
//!
//! Resolution priority: env var > config file (with `${VAR}` expansion) > code default.
//!
//! **config.rs owns all configuration types.** Other modules (rpc_backend, indexer,
//! api_server, validation) import what they need. This keeps serde concerns centralized
//! and component modules focused on runtime behavior.

use std::path::Path;
use std::time::Duration;

use regex::Regex;
use serde::Deserialize;
use starknet_types_core::felt::Felt;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("failed to read config file: {0}")]
    ReadFile(#[source] std::io::Error),
    #[error("failed to parse config file: {0}")]
    ParseToml(#[source] toml::de::Error),
    #[error(
        "environment variable '{0}' is required but not set (referenced in config as ${{...}})"
    )]
    EnvVarRequired(String),
    #[error("missing required config: {0}")]
    MissingRequired(String),
    #[error("invalid value for {field}: {reason}")]
    InvalidValue { field: String, reason: String },
}

/// Configuration for the RPC backend (flattened, no nested pool section).
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct RpcConfig {
    pub url: String,
    pub max_concurrent_requests: usize,
    #[serde(deserialize_with = "deserialize_secs")]
    pub connect_timeout: Duration,
    #[serde(deserialize_with = "deserialize_secs")]
    pub request_timeout: Duration,
    pub max_idle_per_host: usize,
}

impl Default for RpcConfig {
    fn default() -> Self {
        Self {
            url: "http://127.0.0.1:5050".to_string(),
            max_concurrent_requests: 10,
            connect_timeout: Duration::from_secs(30),
            request_timeout: Duration::from_secs(60),
            max_idle_per_host: 10,
        }
    }
}

/// Configuration for the WebSocket indexer.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct IndexerConfig {
    pub ws_url: String,
    #[serde(deserialize_with = "deserialize_secs")]
    pub connect_timeout: Duration,
    #[serde(deserialize_with = "deserialize_secs")]
    pub backoff_initial_interval: Duration,
    #[serde(deserialize_with = "deserialize_secs")]
    pub backoff_max_interval: Duration,
    /// Omit for infinite retries.
    #[serde(default, deserialize_with = "deserialize_optional_secs")]
    pub backoff_max_elapsed_time: Option<Duration>,
}

impl Default for IndexerConfig {
    fn default() -> Self {
        Self {
            ws_url: "ws://127.0.0.1:5050/ws".to_string(),
            connect_timeout: Duration::from_secs(10),
            backoff_initial_interval: Duration::from_secs(1),
            backoff_max_interval: Duration::from_secs(60),
            backoff_max_elapsed_time: None,
        }
    }
}

/// Configuration for the API server.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ApiServerConfig {
    pub host: String,
    pub health_max_lag_secs: u64,
    /// Populated from the `[limits]` section by `build_configs()`, not deserialized directly.
    #[serde(skip_deserializing)]
    pub validation_limits: ValidationLimits,
}

impl Default for ApiServerConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1:8080".to_string(),
            health_max_lag_secs: 5,
            validation_limits: ValidationLimits::default(),
        }
    }
}

/// Configurable validation limits for sync endpoints.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ValidationLimits {
    /// Maximum number of channels allowed in the cursor.
    pub max_cursor_channels: usize,
    /// Maximum number of subchannels allowed per channel in the cursor.
    pub max_cursor_subchannels_per_channel: usize,
    /// Maximum number of recipients in an outgoing sync filter.
    pub max_outgoing_recipients: usize,
    /// Server-controlled I/O budget per request.
    pub server_budget: usize,
    /// Budget cap per batch within a single request.
    pub batch_budget: usize,
}

impl Default for ValidationLimits {
    fn default() -> Self {
        Self {
            max_cursor_channels: 256,
            max_cursor_subchannels_per_channel: 64,
            max_outgoing_recipients: 64,
            server_budget: 100,
            batch_budget: 16,
        }
    }
}

/// `contract_address` is required — no default. Stays `Option` so we can detect "not provided".
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct PrivacyPoolConfig {
    pub contract_address: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct LoggingConfig {
    pub level: Option<String>,
}

/// Top-level service configuration deserialized from TOML.
/// Omitted fields get defaults from `#[serde(default)]` on each struct.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ServiceConfig {
    pub privacy_pool: PrivacyPoolConfig,
    pub rpc: RpcConfig,
    pub indexer: IndexerConfig,
    pub api: ApiServerConfig,
    pub logging: LoggingConfig,
    pub limits: ValidationLimits,
}

impl ServiceConfig {
    /// Load config from a TOML file, expanding `${VAR}` / `${VAR:-default}` references.
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let raw = std::fs::read_to_string(path).map_err(ConfigError::ReadFile)?;
        let expanded = expand_env_vars(&raw)?;
        toml::from_str(&expanded).map_err(ConfigError::ParseToml)
    }

    /// Override config fields with known env vars (applied after file loading).
    pub fn apply_env_overrides(&mut self) {
        if let Ok(v) = std::env::var("CONTRACT_ADDRESS") {
            self.privacy_pool.contract_address = Some(v);
        }
        if let Ok(v) = std::env::var("RPC_URL") {
            self.rpc.url = v;
        }
        if let Ok(v) = std::env::var("WS_URL") {
            self.indexer.ws_url = v;
        }
        if let Ok(v) = std::env::var("API_HOST") {
            self.api.host = v;
        }
        if let Ok(v) = std::env::var("RUST_LOG") {
            self.logging.level = Some(v);
        }
        if let Ok(v) = std::env::var("SERVER_BUDGET") {
            if let Ok(n) = v.parse() {
                self.limits.server_budget = n;
            }
        }
        if let Ok(v) = std::env::var("BATCH_BUDGET") {
            if let Ok(n) = v.parse() {
                self.limits.batch_budget = n;
            }
        }
    }

    /// Validate required fields after all overrides are applied.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.privacy_pool.contract_address.is_none() {
            return Err(ConfigError::MissingRequired(
                "privacy_pool.contract_address (or CONTRACT_ADDRESS env var)".to_string(),
            ));
        }
        Ok(())
    }

    /// Parse the contract address string into a Felt.
    fn contract_address(&self) -> Result<Felt, ConfigError> {
        let s = self
            .privacy_pool
            .contract_address
            .as_deref()
            .ok_or_else(|| {
                ConfigError::MissingRequired("privacy_pool.contract_address".to_string())
            })?;
        s.parse().map_err(
            |e: starknet_types_core::felt::FromStrError| ConfigError::InvalidValue {
                field: "privacy_pool.contract_address".to_string(),
                reason: e.to_string(),
            },
        )
    }

    /// Build component configs from the service config.
    ///
    /// Defaults were already applied at deserialization time via `#[serde(default)]`,
    /// so this just injects `limits` into `api` and parses the contract address.
    /// Must be called after `apply_env_overrides()` and `validate()`.
    pub fn build_configs(
        mut self,
    ) -> Result<(RpcConfig, Felt, IndexerConfig, ApiServerConfig), ConfigError> {
        let contract_address = self.contract_address()?;
        self.api.validation_limits = self.limits;
        Ok((self.rpc, contract_address, self.indexer, self.api))
    }
}

/// Deserialize a `u64` as `Duration` (seconds).
fn deserialize_secs<'de, D>(deserializer: D) -> Result<Duration, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Duration::from_secs(u64::deserialize(deserializer)?))
}

/// Deserialize an optional `u64` as `Option<Duration>` (seconds).
fn deserialize_optional_secs<'de, D>(deserializer: D) -> Result<Option<Duration>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<u64>::deserialize(deserializer)?.map(Duration::from_secs))
}

/// Expand `${VAR}` and `${VAR:-default}` patterns in a string.
fn expand_env_vars(input: &str) -> Result<String, ConfigError> {
    let re = Regex::new(r"\$\{([^}:]+)(?::-([^}]*))?\}").expect("valid regex");
    let mut result = String::with_capacity(input.len());
    let mut last_end = 0;

    for caps in re.captures_iter(input) {
        let m = caps.get(0).unwrap();
        result.push_str(&input[last_end..m.start()]);

        let var_name = &caps[1];
        match std::env::var(var_name) {
            Ok(val) if !val.is_empty() => result.push_str(&val),
            _ => {
                if let Some(default) = caps.get(2) {
                    result.push_str(default.as_str());
                } else {
                    return Err(ConfigError::EnvVarRequired(var_name.to_string()));
                }
            }
        }

        last_end = m.end();
    }

    result.push_str(&input[last_end..]);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_expand_env_vars_with_default() {
        // SAFETY: test-only, single-threaded access to unique env var name.
        unsafe { std::env::remove_var("__TEST_MISSING_VAR") };
        let input = "url = \"${__TEST_MISSING_VAR:-http://localhost:5050}\"";
        let result = expand_env_vars(input).unwrap();
        assert_eq!(result, "url = \"http://localhost:5050\"");
    }

    #[test]
    fn test_expand_env_vars_present() {
        // SAFETY: test-only, single-threaded access to unique env var name.
        unsafe { std::env::set_var("__TEST_PRESENT_VAR", "custom_value") };
        let input = "url = \"${__TEST_PRESENT_VAR:-fallback}\"";
        let result = expand_env_vars(input).unwrap();
        assert_eq!(result, "url = \"custom_value\"");
        unsafe { std::env::remove_var("__TEST_PRESENT_VAR") };
    }

    #[test]
    fn test_expand_env_vars_required_missing() {
        // SAFETY: test-only, single-threaded access to unique env var name.
        unsafe { std::env::remove_var("__TEST_REQUIRED_MISSING") };
        let input = "url = \"${__TEST_REQUIRED_MISSING}\"";
        let result = expand_env_vars(input);
        assert!(result.is_err());
    }

    #[test]
    fn test_load_minimal_config() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            f,
            r#"
[privacy_pool]
contract_address = "0x1234"
"#
        )
        .unwrap();

        let config = ServiceConfig::load(f.path()).unwrap();
        assert_eq!(
            config.privacy_pool.contract_address.as_deref(),
            Some("0x1234")
        );
        // Unspecified fields get defaults
        let rpc_defaults = RpcConfig::default();
        assert_eq!(config.rpc.url, rpc_defaults.url);
        let idx_defaults = IndexerConfig::default();
        assert_eq!(config.indexer.ws_url, idx_defaults.ws_url);
    }

    #[test]
    fn test_load_full_config() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            f,
            r#"
[privacy_pool]
contract_address = "0xabc"

[rpc]
url = "http://rpc:5050"
max_concurrent_requests = 20

[indexer]
ws_url = "ws://ws:5050/ws"
connect_timeout = 5

[api]
host = "0.0.0.0:9090"
health_max_lag_secs = 10

[logging]
level = "debug"

[limits]
max_cursor_channels = 128
server_budget = 50
"#
        )
        .unwrap();

        let config = ServiceConfig::load(f.path()).unwrap();
        assert_eq!(config.rpc.url, "http://rpc:5050");
        assert_eq!(config.rpc.max_concurrent_requests, 20);
        assert_eq!(config.indexer.ws_url, "ws://ws:5050/ws");
        assert_eq!(config.indexer.connect_timeout, Duration::from_secs(5));
        assert_eq!(config.api.host, "0.0.0.0:9090");
        assert_eq!(config.api.health_max_lag_secs, 10);
        assert_eq!(config.logging.level.as_deref(), Some("debug"));
        assert_eq!(config.limits.max_cursor_channels, 128);
        assert_eq!(config.limits.server_budget, 50);
    }

    #[test]
    fn test_env_override_takes_precedence() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            f,
            r#"
[privacy_pool]
contract_address = "0xfile"

[api]
host = "127.0.0.1:8080"
"#
        )
        .unwrap();

        // SAFETY: test-only, no other test touches these env vars concurrently.
        unsafe {
            std::env::set_var("CONTRACT_ADDRESS", "0xenv");
            std::env::set_var("API_HOST", "0.0.0.0:9999");
        }

        let mut config = ServiceConfig::load(f.path()).unwrap();
        config.apply_env_overrides();

        assert_eq!(
            config.privacy_pool.contract_address.as_deref(),
            Some("0xenv")
        );
        assert_eq!(config.api.host, "0.0.0.0:9999");

        unsafe {
            std::env::remove_var("CONTRACT_ADDRESS");
            std::env::remove_var("API_HOST");
        }
    }

    #[test]
    fn test_validate_missing_contract_address() {
        let config = ServiceConfig::default();
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_with_contract_address() {
        let mut config = ServiceConfig::default();
        config.privacy_pool.contract_address = Some("0x1".to_string());
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_default_without_file() {
        let mut config = ServiceConfig::default();
        config.privacy_pool.contract_address = Some("0xabc".to_string());
        assert!(config.validate().is_ok());
        assert_eq!(
            config.privacy_pool.contract_address.as_deref(),
            Some("0xabc")
        );
    }

    #[test]
    fn test_contract_address_parsing() {
        let mut config = ServiceConfig::default();
        config.privacy_pool.contract_address = Some("0x1234".to_string());
        let felt = config.contract_address().unwrap();
        assert_eq!(felt, Felt::from_hex_unchecked("0x1234"));
    }

    #[test]
    fn test_contract_address_invalid() {
        let mut config = ServiceConfig::default();
        config.privacy_pool.contract_address = Some("not_a_felt".to_string());
        assert!(config.contract_address().is_err());
    }

    #[test]
    fn test_build_configs_uses_component_defaults() {
        let mut config = ServiceConfig::default();
        config.privacy_pool.contract_address = Some("0x1".to_string());

        let (rpc, contract_address, idx, api) = config.build_configs().unwrap();

        assert_eq!(contract_address, Felt::from_hex_unchecked("0x1"));

        let rpc_defaults = RpcConfig::default();
        assert_eq!(rpc.url, rpc_defaults.url);
        assert_eq!(
            rpc.max_concurrent_requests,
            rpc_defaults.max_concurrent_requests
        );

        let idx_defaults = IndexerConfig::default();
        assert_eq!(idx.ws_url, idx_defaults.ws_url);
        assert_eq!(idx.connect_timeout, idx_defaults.connect_timeout);

        let api_defaults = ApiServerConfig::default();
        assert_eq!(api.host, api_defaults.host);
        assert_eq!(api.health_max_lag_secs, api_defaults.health_max_lag_secs);
    }

    #[test]
    fn test_build_configs_with_overrides() {
        let mut config = ServiceConfig::default();
        config.privacy_pool.contract_address = Some("0x1".to_string());
        config.rpc.url = "http://custom:9999".to_string();
        config.indexer.connect_timeout = Duration::from_secs(42);
        config.api.host = "0.0.0.0:3000".to_string();
        config.limits.server_budget = 200;

        let (_rpc, _contract_address, idx, api) = config.build_configs().unwrap();

        assert_eq!(idx.connect_timeout, Duration::from_secs(42));
        assert_eq!(api.host, "0.0.0.0:3000");
        assert_eq!(api.validation_limits.server_budget, 200);
    }
}
