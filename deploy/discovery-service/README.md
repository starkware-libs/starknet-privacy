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

All settings can be provided via environment variables or a TOML config file (`--config path/to/config.toml`).

| Env var | Purpose | Default |
|---|---|---|
| `RPC_URL` | StarkNet RPC endpoint | `http://127.0.0.1:5050` |
| `WS_URL` | StarkNet WebSocket endpoint | `ws://127.0.0.1:5050/ws` |
| `API_HOST` | Bind address for HTTP API | `0.0.0.0:8080` (in Docker) / `127.0.0.1:8080` (native) |
| `RUST_LOG` | Log level filter | `info` |
| `SERVER_BUDGET` | I/O budget per request | `100` |

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
