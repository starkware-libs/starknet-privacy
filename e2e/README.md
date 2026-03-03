# e2e

End-to-end tests and fixture generation for the privacy pool.

## Prerequisites

1. Install the patched starknet-devnet (see [SDK README](../sdk/README.md#starknet-devnet) for instructions)
2. Build the privacy contract: `scarb build`
3. Build the SDK: `cd sdk && npm run build`
4. Install e2e dependencies: `npm install`

## Tests

```bash
npm test
```

### Smoke (`tests/smoke.test.ts`)

Minimal end-to-end flow: deploys the privacy pool contract, starts the indexer,
and verifies that a single deposit + transfer is discoverable via the indexer.
Uses the default 2-account devnet (Alice and Bob) with a single token (STRK).

### Payment Service Discovery (`tests/payment-service-discovery.test.ts`)

Stress test for paginated indexer discovery. Alice acts as a payment service
interacting with 9 users across 2 tokens (STRK and ETH) over 7 rounds of
transactions, producing ~94 notes (~38 spent). The volume forces multi-page
pagination (SERVER_BUDGET=100, COST_NOTE=2).

Verifies:
- Alice discovers notes from multiple senders across both tokens
- Alice discovers outgoing channels to all 9 users (plus self)
- Every user discovers their own notes
- Every user discovers their channel to Alice

### Reorg Recovery (`tests/reorg-recovery.test.ts`)

Verifies that the SDK handles indexer reorg responses gracefully. Injects a
fake cursor with an invalid block ID, triggering an HTTP 409 (BLOCK_REORGED)
from the indexer. The SDK should clear the registry and retry from scratch
without surfacing the error to the caller.

## Scripts

See [`scripts/README.md`](scripts/README.md) for load testing and batch operation scripts.

## Linting

```bash
npm run lint:check   # check only
npm run lint         # check and auto-fix
```

## Fixture generation

Regenerate Rust crate test fixtures when the contract or SDK test scenario changes:

```bash
npm run generate-dump
```

This writes fixtures directly to:
- `crates/discovery-core/tests/fixtures/devnet-state.json` -- contract storage slots
- `crates/discovery-service/tests/fixtures/devnet-dump.json.gz` -- full devnet state
- `crates/discovery-service/tests/fixtures/devnet-dump.metadata.json` -- timestamp + addresses

After regenerating, run `cargo test` from the repo root to confirm Rust tests still pass.

## Declaring a new contract class

When the Cairo contract changes (new constructor param, logic update, etc.), the class hash
changes and must be re-declared on the target network before deploying new instances.

```bash
# 1. Rebuild the contract (release profile — no debug info, full inlining)
scarb --profile release build

# 2. Declare (reads RPC_URL and ACCOUNTS from .env)
npm run declare-class
```

The script computes the class hash locally, checks whether it's already declared on-chain,
and submits a DECLARE v3 transaction if needed. On success it prints the new class hash —
update `POOL_CLASS_HASH` in `.env` to match.

## Privacy StarkNet integration (`tests/privacy-starknet-integration.test.ts`)

Tests against a real (non-devnet) StarkNet deployment on integration sepolia.
Spawns the discovery service indexer, runs preflight and deposit flows via the SDK.

Requires network access and a `.env` file with account credentials and contract addresses.

### Setting up `.env`

1. Copy the example file: `cp .env.example .env`
2. Fill in real values from the shared team document (search for "PrivacyDummyAccount")

The `ACCOUNTS` env var is a JSON array of account entries:

```json
[
  {"name": "admin", "address": "0x...", "privateKey": "0x...", "viewingKey": "0x..."},
  {"name": "alice", "address": "0x...", "privateKey": "0x...", "viewingKey": "0x..."}
]
```

The test uses `admin` as the minter (OZ account) and `alice` as the privacy account.
`alice` uses the `PrivacyDummyAccount` class (trivial signer, no signature required).

```bash
npx vitest run tests/privacy-starknet-integration.test.ts
```

## Ekubo Swap integration (`tests/swap-ekubo-integration.test.ts`)

Runs the deposit + swap + discovery flow against integration Sepolia using:
- freshly deployed privacy pool (per test run),
- Ekubo Core + Router + Positions + privacy EkuboSwapExecutor deployed via scripts.

### One-time setup

```bash
# 1. Build Ekubo contract artifacts
cd e2e/ekubo-contracts && scarb build

# 2. Build privacy contract artifacts (from repo root)
scarb build

# 3. Declare + deploy + seed Ekubo infra (Core, Router, Positions)
cd e2e && npm run setup-ekubo

# 4. Declare + deploy EkuboSwapExecutor
cd e2e && npm run setup-executor
```

Copy printed addresses into `.env`:
- `EKUBO_CORE_ADDRESS`
- `EKUBO_ROUTER_ADDRESS`
- `EKUBO_POSITIONS_ADDRESS`
- `EXECUTOR_ADDRESS`

All scripts are idempotent — re-running skips already-deployed contracts.
`setup-ekubo` always runs the seed phase, enabling liquidity top-ups.

### Required env for Ekubo test

- `FEE_TOKEN_ADDRESS`
- `EXECUTOR_ADDRESS`
- `EKUBO_POOL_TOKEN0`, `EKUBO_POOL_TOKEN1`, `EKUBO_POOL_FEE`, `EKUBO_TICK_SPACING`, `EKUBO_EXTENSION`
- `EKUBO_SQRT_RATIO_LIMIT`, `EKUBO_SKIP_AHEAD`
- `EKUBO_POOL_INITIAL_TICK`, `EKUBO_SEED_AMOUNT0`, `EKUBO_SEED_AMOUNT1`
- `EKUBO_POSITION_LOWER_BOUND`, `EKUBO_POSITION_UPPER_BOUND`

### Run

```bash
npx vitest run tests/swap-ekubo-integration.test.ts
```

## Inspecting Ekubo contract sources

Scarb caches git dependencies locally. To browse the Ekubo contract source code
(Router, Core, Positions, etc.) for the pinned revision:

```bash
# Find the cache directory
scarb cache path
# → e.g. /Users/<you>/Library/Caches/com.swmansion.scarb  (macOS)
#        ~/.cache/com.swmansion.scarb                       (Linux)

# Ekubo sources are under registry/git/checkouts/
ls "$(scarb cache path)/registry/git/checkouts/starknet-contracts-"*/

# The subdirectory is named after the pinned rev (first 7 chars of the commit hash).
# For example, if Scarb.toml pins rev "8b4de8b...", look in:
ls "$(scarb cache path)/registry/git/checkouts/starknet-contracts-*/8b4de8b/src/"
```

Key files:
- `src/router.cairo` — Router swap/multihop_swap logic, callback-based settlement
- `src/components/clear.cairo` — `clear()` / `clear_minimum()` entrypoints
- `src/components/util.cairo` — `handle_delta()` (withdraw/pay settlement with Core)
- `src/interfaces/router.cairo` — `RouteNode`, `TokenAmount`, `Swap` struct definitions
- `src/interfaces/erc20.cairo` — ERC-20 interface Ekubo uses (camelCase: `balanceOf`, `transferFrom`)
- `src/math/ticks.cairo` — `MIN_SQRT_RATIO`, `MAX_SQRT_RATIO` constants
