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

Smoke tests spin up a live devnet, deploy contracts, run the indexer, and verify the full flow.

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
