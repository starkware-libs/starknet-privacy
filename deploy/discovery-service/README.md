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

## Configuration

All settings can be provided via environment variables or a TOML config file. For the full list of config fields, env var overrides, and loading precedence, see [spec 18 — Configuration](../../crates/discovery-service/specs/18-configuration.md).

### Environment variables

| Env var | Purpose | Default |
|---|---|---|
| `RPC_URL` | StarkNet RPC endpoint | `http://127.0.0.1:5050` |
| `WS_URL` | StarkNet WebSocket endpoint | `ws://127.0.0.1:5050/ws` |
| `API_HOST` | Bind address for HTTP API | `0.0.0.0:8080` (in Docker) / `127.0.0.1:8080` (native) |
| `RUST_LOG` | Log level filter | `info` |
| `SERVER_BUDGET` | I/O budget per request | `100` |
| `BATCH_BUDGET` | Budget cap per batch | `16` |
| `TLS_CERT_PATH` | Path to PEM certificate for TLS | — (TLS disabled) |
| `TLS_KEY_PATH` | Path to PEM private key for TLS | — (TLS disabled) |

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
