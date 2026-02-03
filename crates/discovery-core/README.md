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

The devnet state fixture contains real storage slots from SDK integration tests.
To regenerate:

1. Start devnet: `starknet-devnet --seed 42`
2. Run SDK tests with dump enabled:
   ```bash
   cd sdk
   DUMP_STATE_PATH=../crates/discovery-core/tests/fixtures/devnet-state.json npm test
   ```
