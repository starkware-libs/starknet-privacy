# 18. Configuration

## Overview

The discovery service uses a layered configuration system with three levels of precedence:

```
env var > config file (with ${VAR} expansion) > code default
```

- **Tests:** set env vars directly (no config file needed)
- **Docker:** set env vars in compose (no config file needed)
- **Production:** config file with `${VAR:-default}` for secrets/endpoints, env vars for per-instance overrides

## CLI Arguments

```
--config <path>    Optional path to TOML config file
```

No other CLI args. All configuration is via file and/or env vars.

## Config File Format (TOML)

All sections and fields are optional. Supports env var expansion: `${VAR}` (required) and `${VAR:-default}` (with fallback).

```toml
[rpc]
url = "http://127.0.0.1:5050"
max_concurrent_requests = 10
connect_timeout = 30        # seconds
request_timeout = 60        # seconds
max_idle_per_host = 10

[indexer]
ws_url = "ws://127.0.0.1:5050/ws"
connect_timeout = 10        # seconds
backoff_initial_interval = 1
backoff_max_interval = 60
# backoff_max_elapsed_time — omit for infinite retries

[api]
host = "127.0.0.1:8080"
health_max_lag_secs = 5
request_timeout = 30        # seconds

[logging]
level = "info"

[limits]
max_cursor_channels = 256
max_cursor_subchannels_per_channel = 64
max_outgoing_recipients = 64
server_budget = 100
max_request_body_bytes = 102400
batch_budget = 16
```

**Budget clamping:** `server_budget` is clamped to `MIN_SERVER_BUDGET` (3 = `COST_CHANNEL_INFO`) at startup. Values below the minimum trigger a warning log and are raised to the minimum.

## Env Var Overrides

These env vars override the corresponding config file values at runtime:

| Env var | Config path | Default |
|---|---|---|
| `RPC_URL` | `rpc.url` | `http://127.0.0.1:5050` |
| `WS_URL` | `indexer.ws_url` | `ws://127.0.0.1:5050/ws` |
| `API_HOST` | `api.host` | `127.0.0.1:8080` |
| `RUST_LOG` | `logging.level` | `info` |
| `SERVER_BUDGET` | `limits.server_budget` | `100` |
| `BATCH_BUDGET` | `limits.batch_budget` | `16` |

RPC pool settings, indexer timeouts, and validation limits (except server/batch budget) have no env var — configurable only via file.

## Env Var Expansion

Pre-processes raw TOML text before parsing. Regex: `\$\{([^}:]+)(?::-([^}]*))?\}`

- `${VAR}` — substitute value; error if unset or empty
- `${VAR:-default}` — substitute value; use default if unset or empty

This is text substitution on the file content, separate from env var overrides which are field-level after parsing.

## Required Fields

No required fields. All configuration has sensible defaults. The contract address is provided per-request via the API endpoints.

## Loading Sequence

1. Parse `--config` CLI arg
2. If config path provided: read file → expand env vars → parse TOML
3. If no config path: use `ServiceConfig::default()` (all defaults)
4. Apply env var overrides (`apply_env_overrides`)
5. Construct component configs from resolved values

## Implementation

- All config types live in a single `config` module — the single owner of configuration concerns
- Component modules import what they need; they don't define their own config structs
- Validation limits are threaded through API server state to handlers
