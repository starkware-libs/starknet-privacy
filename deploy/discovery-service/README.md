# Discovery Service — Build & Deploy

## Local build

### Linux

```bash
apt install pkg-config libssl-dev ca-certificates
cargo build --release -p discovery-service
```

### macOS

```bash
brew install openssl
cargo build --release -p discovery-service
```

The binary is at `target/release/discovery-service`.

## Docker build

Single-platform (current architecture):

```bash
docker build -f deploy/discovery-service/Dockerfile -t discovery-service .
```

Multi-platform:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f deploy/discovery-service/Dockerfile \
  -t discovery-service .
```

## Machine specs

| Spec | Value |
|------|-------|
| Machine type | n2-standard-4 |
| CPU | 4 vCPUs |
| Memory | ~16 GB |
| Arch | amd64 |

## Configuration

The defaults are optimal for most deployments — a config file is not needed unless fine-tuning. All settings can be provided via environment variables or a TOML config file (`--config path/to/config.toml`). See [`config.example.toml`](config.example.toml) for all available fields with defaults, and the [configuration spec](../../crates/discovery-service/specs/18-configuration.md) for full documentation.

Precedence: env var > config file > code default.

| Env var | Config path | Default |
|---|---|---|
| `RPC_URL` | `rpc.url` | `http://127.0.0.1:5050` |
| `WS_URL` | `indexer.ws_url` | `ws://127.0.0.1:5050/ws` |
| `API_HOST` | `api.host` | `0.0.0.0:8080` (Docker) / `127.0.0.1:8080` (native) |
| `RUST_LOG` | `logging.level` | `info` |
| `SERVER_BUDGET` | `limits.server_budget` | `10000` |
| `TLS_CERT_PATH` | `api.tls.cert_path` | — (TLS disabled) |
| `TLS_KEY_PATH` | `api.tls.key_path` | — (TLS disabled) |

Other settings (RPC pool, indexer timeouts, cursor limits) can only be configured via the TOML file.

### Config file

For production deployments, mount a TOML config file into the container and pass `--config`:

```bash
docker run --rm \
  -v /host/path/config.toml:/etc/discovery-service/config.toml:ro \
  -p 8080:8080 \
  discovery-service --config /etc/discovery-service/config.toml
```

When using TLS via the config file, mount the certificate and key files as well:

```bash
docker run --rm \
  -v /host/path/config.toml:/etc/discovery-service/config.toml:ro \
  -v /host/path/cert.pem:/etc/ssl/cert.pem:ro \
  -v /host/path/key.pem:/etc/ssl/key.pem:ro \
  -p 8443:8443 \
  discovery-service --config /etc/discovery-service/config.toml
```

The config file references the in-container paths:

```toml
[api]
host = "0.0.0.0:8443"

[api.tls]
cert_path = "/etc/ssl/cert.pem"
key_path = "/etc/ssl/key.pem"
```

Env vars override config file values when both are set.

## Running

### Docker

```bash
docker run --rm \
  -e RPC_URL=http://host.docker.internal:5050 \
  -e WS_URL=ws://host.docker.internal:5050/ws \
  -p 8080:8080 \
  discovery-service
```

### Native

```bash
RPC_URL=http://127.0.0.1:5050 ./target/release/discovery-service
```

### With TLS

```bash
TLS_CERT_PATH=/etc/ssl/cert.pem TLS_KEY_PATH=/etc/ssl/key.pem \
  ./target/release/discovery-service
```
