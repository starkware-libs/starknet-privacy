# e2e

End-to-end tests and fixture generation for the privacy pool.

## Prerequisites

1. Install the patched starknet-devnet (see [SDK README](../sdk/README.md#starknet-devnet) for instructions)
2. Build the privacy contract: `scarb --profile release build`
3. Build the SDK: `cd sdk && npm run build`
4. Build the discovery service: `cargo build --release -p discovery-service`
5. Install e2e dependencies: `npm install`

## Tests

```bash
npm test              # run all tests
npm run test:devnet   # devnet tests only
npm run test:integration  # integration tests only
```

### Devnet tests (`tests/devnet/`)

#### Smoke (`tests/devnet/smoke.test.ts`)

Minimal end-to-end flow: deploys the privacy pool contract, starts the indexer,
and verifies that a single deposit + transfer is discoverable via the indexer.
Uses the default 2-account devnet (Alice and Bob) with a single token (STRK).

#### Payment Service Discovery (`tests/devnet/payment-service-discovery.test.ts`)

Stress test for paginated indexer discovery. Alice acts as a payment service
interacting with 9 users across 2 tokens (STRK and ETH) over 7 rounds of
transactions, producing ~94 notes (~38 spent). The volume forces multi-page
pagination (SERVER_BUDGET=100, COST_NOTE=2).

Verifies:
- Alice discovers notes from multiple senders across both tokens
- Alice discovers outgoing channels to all 9 users (plus self)
- Every user discovers their own notes
- Every user discovers their channel to Alice

#### Reorg Recovery (`tests/devnet/reorg-recovery.test.ts`)

Verifies that the SDK handles indexer reorg responses gracefully. Injects a
fake cursor with an invalid block ID, triggering an HTTP 409 (BLOCK_REORGED)
from the indexer. The SDK should clear the registry and retry from scratch
without surfacing the error to the caller.

#### Pagination Discovery (`tests/devnet/pagination-discovery.test.ts`)

Tests paginated discovery across multiple channels and tokens.

### Integration tests (`tests/integration/`)

#### Privacy StarkNet integration (`tests/integration/privacy-starknet-integration.test.ts`)

Tests against a real (non-devnet) StarkNet deployment on integration sepolia.
Declares the contract class from built artifacts (no-op if already declared),
deploys a fresh pool instance, spawns the discovery service indexer, and runs
preflight and deposit flows via the SDK.

Requires network access, built contract artifacts (`scarb --profile release build`),
and a `.env` file with account credentials.

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

# 2. Declare (reads VITE_RPC_URL and admin from ACCOUNTS in .env)
npm run declare-class
```

The script computes the class hash locally, checks whether it's already declared on-chain,
and submits a DECLARE v3 transaction if needed. On success it prints the new class hash —
update `VITE_POOL_CLASS_HASH` in `.env` to match.

> **Note:** This manual step is only needed for operational use in the integration environment
> (e.g., deploying pool instances outside of tests, or updating `POOL_CLASS_HASH` for scripts).
> E2e tests — both devnet-based and `privacy-starknet-integration` — declare the class
> internally from built artifacts and do not depend on `POOL_CLASS_HASH`.

## Setting up `.env`

1. Copy the example file: `cp .env.example .env`
2. Fill in real values from the shared team document (search for "PrivacyDummyAccount")

The `ACCOUNTS` env var is a JSON array of all accounts (admin + users).
The admin account must have `"admin": true`:

```json
[
  {"name": "admin", "address": "0x...", "privateKey": "0x...", "viewingKey": "0x0", "salt": "0x...", "admin": true},
  {"name": "alice", "address": "0x...", "privateKey": "0x...", "viewingKey": "0x...", "salt": "0x..."}
]
```

The integration test uses the admin account as the minter (OZ account) and `alice` as
the privacy account.

```bash
npx vitest run tests/integration/privacy-starknet-integration.test.ts
```
