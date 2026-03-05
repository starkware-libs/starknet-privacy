# discovery-core

Core discovery logic for the privacy pool, including storage slot computation and a simple RPC backend for testing and benchmarking.

## Test Vectors

Test vectors are generated from the Cairo contract. To regenerate:

```bash
cd sdk
npm run generate:cairo-refs
cp tests/fixtures/cairo-reference-data.json ../crates/discovery-core/tests/fixtures/cairo-reference-data.json
```

## Devnet State Fixture

The devnet state fixture contains real storage slots produced by the e2e dump script.
To regenerate:

```bash
cd e2e && npm run generate-dump
```

This writes `tests/fixtures/devnet-state.json` (among other crate fixtures).
Run `cargo test -p discovery-core` afterwards to verify.

## See also

- [Project root](../../README.md) — architecture overview, prerequisites, build commands
- [Discovery service](../discovery-service/README.md) — HTTP indexing service built on this library
- [Privacy pool contract](../../packages/privacy/README.md) — Cairo contract (source of truth for storage layout and cryptography)
