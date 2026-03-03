# Vesu Test Contracts

Cairo contracts used by E2E integration and devnet tests for Vesu lending flows.

## Contents

- **MockPragmaOracle** / **MockPragmaSummary** — mock oracle contracts for deterministic price feeds
- **External contracts** (built via `build-external-contracts`): Vesu V2 Pool, PoolFactory, VToken, Oracle

## Building

Requires **Scarb 2.11.4** (pinned in `.tool-versions`) due to the `vesu` dependency pulling `alexandria` which is incompatible with newer Scarb versions.

```bash
cd e2e/contracts/vesu && asdf exec scarb build
```

Or from the e2e directory:

```bash
npm run scarb:build:vesu
```
