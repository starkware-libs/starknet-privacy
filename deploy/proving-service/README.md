# Proving Service — Build & Deploy

The proving service (`starknet_os_runner`) runs in a Docker image built from the [starkware-libs/sequencer](https://github.com/starkware-libs/sequencer) repository. A GitHub Actions workflow builds and pushes multi-arch images to `ghcr.io`.

## Building the image

### Via GitHub Actions UI

1. Go to **Actions** > **Proving Service Docker**
2. Click **Run workflow**
3. Enter the sequencer commit hash
4. Wait for the build (~45 min)

### Via CLI

```bash
gh workflow run proving-service-docker.yaml -f sequencer_commit=<hash>
```

### Image location

```
ghcr.io/starkware-libs/starknet-privacy/proving-service:rev-<commit_hash>
```

## Running

```bash
docker run --rm -p 3000:3000 \
  ghcr.io/starkware-libs/starknet-privacy/proving-service:rev-<hash> \
  --rpc-url https://your-rpc-node.example.com \
  --chain-id SN_SEPOLIA
```

## Configuration

All settings are passed as CLI arguments to the container entrypoint.

| Argument | Description | Default |
|---|---|---|
| `--config-file` | Path to JSON configuration file | none |
| `--rpc-url` | RPC node URL for state fetching | **required** |
| `--chain-id` | Chain identifier (`SN_MAIN`, `SN_SEPOLIA`) | **required** |
| `--port` | Server port | `3000` |
| `--ip` | Server bind address | `0.0.0.0` |
| `--max-concurrent-requests` | Max concurrent proving requests | `2` |
| `--max-connections` | Max simultaneous JSON-RPC connections | `10` |
| `--strk-fee-token-address` | Custom STRK fee token address | chain default |

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `RUST_LOG` | Log level filter | `info,starknet_os_runner=debug` |

## JSON-RPC interface

The service exposes a JSON-RPC API on port 3000.

| Method | Description |
|---|---|
| `starknet_proveTransaction` | Submit a transaction for proving |
| `starknet_specVersion` | Health check / version query |
