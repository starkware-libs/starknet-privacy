# Pathfinder — Build & Deploy

Temporarily using a custom Pathfinder build from [Docker Hub](https://hub.docker.com/r/eqlabs/pathfinder/tags):

```bash
docker pull eqlabs/pathfinder:snapshot-cb5c42b005562fca59c2ef044e83aa1464d4f58f
```

## Configuration

Pathfinder requires custom [blockifier versioned constants](https://github.com/starkware-libs/sequencer/blob/APOLLO-PRE-PROOF-DEMO-16/crates/blockifier/resources/blockifier_versioned_constants_0_14_2.json) mounted into the container.

| Env var | Purpose |
|---------|---------|
| `PATHFINDER_RPC_CORS_DOMAINS` | Allowed CORS origins (`*` for local dev) |
| `PATHFINDER_RPC_CUSTOM_VERSIONED_CONSTANTS_JSON_PATH` | Path to blockifier constants inside the container |

Args: `--rpc.websocket.enabled`

It is recommended to set `--rpc.batch-concurrency-limit` (e.g. to 8) to improve performance of batch queries that are actively used by the discovery service when indexing notes.

## Running

```bash
docker run --rm \
  -e PATHFINDER_RPC_CORS_DOMAINS=* \
  -e PATHFINDER_RPC_CUSTOM_VERSIONED_CONSTANTS_JSON_PATH=blockifier_versioned_constants_0_14_2.json \
  -v /path/to/blockifier_versioned_constants_0_14_2.json:/usr/share/pathfinder/blockifier_versioned_constants_0_14_2.json \
  -p 9545:9545 \
  eqlabs/pathfinder:snapshot-cb5c42b005562fca59c2ef044e83aa1464d4f58f \
  --rpc.websocket.enabled \
  --rpc.batch-concurrency-limit 8
```

## Fake L1 (Anvil)

Pathfinder requires an L1 endpoint. For local development, use a fake L1 based on [Anvil](https://www.getfoundry.sh/guides/docker#running-anvil-in-docker).

The entrypoint script ([`fake-l1-entrypoint.sh`](fake-l1-entrypoint.sh)):
1. Starts Anvil on `0.0.0.0:8545` with 1-second block time
2. Waits for Anvil to be ready
3. Compiles a minimal StarknetCore Solidity contract with hardcoded genesis root and block hash
4. Deploys bytecode to `0x4fA369fEBf0C574ea05EC12bC0e1Bc9Cd461Dd0f` via `anvil_setCode`
5. Loops every 2 seconds to re-inject if code disappears

```bash
docker run --rm -p 8545:8545 \
  -v $(pwd)/deploy/pathfinder/fake-l1-entrypoint.sh:/entrypoint.sh \
  --entrypoint /entrypoint.sh \
  ghcr.io/foundry-rs/foundry:latest
```
