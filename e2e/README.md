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
