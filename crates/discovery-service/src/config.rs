//! Configuration loading with TOML file support and env var overrides.
//!
//! Resolution priority: env var > config file (with `${VAR}` expansion) > code default.
//!
//! **config.rs owns all configuration types.** Other modules (rpc_backend, indexer,
//! api_server, validation) import what they need. This keeps serde concerns centralized
//! and component modules focused on runtime behavior.

use std::path::Path;
use std::time::Duration;

use discovery_core::discovery::{min_server_budget, CursorLimits};
use regex::Regex;
use serde::Deserialize;
use thiserror::Error;
use tracing::warn;

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
    /// Maximum number of storage slots per JSON-RPC batch request.
    /// Larger `read_slots` calls are automatically chunked.
    pub max_batch_size: usize,
}

impl Default for RpcConfig {
    fn default() -> Self {
        Self {
            url: "http://127.0.0.1:5050".to_string(),
            max_concurrent_requests: 10,
            connect_timeout: Duration::from_secs(60),
            request_timeout: Duration::from_secs(30),
            max_idle_per_host: 10,
            max_batch_size: 256,
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
    /// Maximum duration for an HTTP request before timeout.
    #[serde(deserialize_with = "deserialize_secs")]
    pub request_timeout: Duration,
    /// Populated from the `[limits]` section by `build_configs()`, not deserialized directly.
    #[serde(skip_deserializing)]
    pub validation_limits: ValidationLimits,
}

impl Default for ApiServerConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1:8080".to_string(),
            health_max_lag_secs: 5,
            request_timeout: Duration::from_secs(30),
            validation_limits: ValidationLimits::default(),
        }
    }
}

/// Configurable validation limits for sync endpoints.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ValidationLimits {
    /// Limits on cursor size (channels and subchannels per channel).
    #[serde(flatten)]
    pub cursor_limits: CursorLimits,
    /// Maximum number of recipients in an outgoing sync filter.
    pub max_outgoing_recipients: usize,
    /// Server-controlled I/O budget per request.
    pub server_budget: usize,
    /// Maximum request body size in bytes.
    pub max_request_body_bytes: usize,
    /// Maximum number of entries in the public key cache.
    pub public_key_cache_capacity: u64,
}

impl Default for ValidationLimits {
    fn default() -> Self {
        Self {
            cursor_limits: CursorLimits::default(),
            max_outgoing_recipients: 64,
            server_budget: 10_000,
            max_request_body_bytes: 102_400,
            public_key_cache_capacity: 10_000,
        }
    }
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
    }

    /// Build component configs from the service config.
    ///
    /// Defaults were already applied at deserialization time via `#[serde(default)]`,
    /// so this just injects `limits` into `api`.
    /// Must be called after `apply_env_overrides()`.
    pub fn build_configs(mut self) -> (RpcConfig, IndexerConfig, ApiServerConfig) {
        let min_budget = min_server_budget(self.limits.cursor_limits.max_note_log_index);
        if self.limits.server_budget < min_budget {
            warn!(
                configured = self.limits.server_budget,
                minimum = min_budget,
                "server_budget below minimum, clamping"
            );
            self.limits.server_budget = min_budget;
        }
        self.api.validation_limits = self.limits;
        (self.rpc, self.indexer, self.api)
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
        writeln!(f).unwrap();

        let config = ServiceConfig::load(f.path()).unwrap();
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
max_channels = 128
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
        assert_eq!(config.limits.cursor_limits.max_channels, 128);
        assert_eq!(config.limits.server_budget, 50);
    }

    #[test]
    fn test_env_override_takes_precedence() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            f,
            r#"
[api]
host = "127.0.0.1:8080"
"#
        )
        .unwrap();

        // SAFETY: test-only, no other test touches these env vars concurrently.
        unsafe {
            std::env::set_var("API_HOST", "0.0.0.0:9999");
        }

        let mut config = ServiceConfig::load(f.path()).unwrap();
        config.apply_env_overrides();

        assert_eq!(config.api.host, "0.0.0.0:9999");

        unsafe {
            std::env::remove_var("API_HOST");
        }
    }

    #[test]
    fn test_build_configs_uses_component_defaults() {
        let config = ServiceConfig::default();

        let (rpc, idx, api) = config.build_configs();

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
    fn test_build_configs_clamps_budget_below_minimum() {
        let mut config = ServiceConfig::default();
        let min_budget = min_server_budget(config.limits.cursor_limits.max_note_log_index);
        config.limits.server_budget = 1;

        let (_, _, api) = config.build_configs();

        assert_eq!(
            api.validation_limits.server_budget, min_budget,
            "budget below minimum should be clamped to min_server_budget"
        );
    }

    #[test]
    fn test_build_configs_preserves_budget_at_minimum() {
        let mut config = ServiceConfig::default();
        let min_budget = min_server_budget(config.limits.cursor_limits.max_note_log_index);
        config.limits.server_budget = min_budget;

        let (_, _, api) = config.build_configs();

        assert_eq!(api.validation_limits.server_budget, min_budget);
    }

    #[test]
    fn test_build_configs_preserves_budget_above_minimum() {
        let mut config = ServiceConfig::default();
        config.limits.server_budget = 200;

        let (_, _, api) = config.build_configs();

        assert_eq!(api.validation_limits.server_budget, 200);
    }

    #[test]
    fn test_build_configs_with_overrides() {
        let mut config = ServiceConfig::default();
        config.rpc.url = "http://custom:9999".to_string();
        config.indexer.connect_timeout = Duration::from_secs(42);
        config.api.host = "0.0.0.0:3000".to_string();
        config.limits.server_budget = 200;

        let (_rpc, idx, api) = config.build_configs();

        assert_eq!(idx.connect_timeout, Duration::from_secs(42));
        assert_eq!(api.host, "0.0.0.0:3000");
        assert_eq!(api.validation_limits.server_budget, 200);
    }
}
