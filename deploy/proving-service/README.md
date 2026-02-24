# Proving Service — Build & Deploy

The proving service runs two binaries in a single Docker image:

- `starknet_os_runner` — built from [starkware-libs/sequencer](https://github.com/starkware-libs/sequencer)
- `stwo_run_and_prove` — built from [starkware-libs/proving-utils](https://github.com/starkware-libs/proving-utils)

A GitHub Actions workflow builds and pushes multi-arch images to `ghcr.io`.

## Build architecture

The build is split into parallel jobs to stay within CI time limits:

| Dockerfile | Builds | Output |
|---|---|---|
| `Dockerfile.sequencer` | `starknet_os_runner` + bootloader resource | uploaded as artifact |
| `Dockerfile.proving-utils` | `stwo_run_and_prove` | uploaded as artifact |
| `Dockerfile` | Runtime image (assembles pre-built binaries) | pushed to registry |

The `build-sequencer` and `build-proving-utils` jobs run in parallel (per arch), then the `assemble` job combines their artifacts into the final runtime image.

## Building the image

The workflow triggers automatically on push to `main` or on PRs that change files in `deploy/proving-service/` or the workflow itself.

To build a new image, update the commit hashes in `deploy/proving-service/revisions.env`:

```env
SEQUENCER_COMMIT=<full_sha>
PROVING_UTILS_COMMIT=<full_sha>
```

Then push. The image will be tagged `rev-<short_sequencer_sha>-<short_proving_utils_sha>`.

### Image location

```
ghcr.io/starkware-libs/starknet-privacy/proving-service:rev-<seq_sha7>-<pu_sha7>
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
