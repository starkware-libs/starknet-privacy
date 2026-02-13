# e2e

End-to-end tests and fixture generation for the privacy pool.

## Prerequisites

1. Install starknet-devnet: `cargo install starknet-devnet`
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
