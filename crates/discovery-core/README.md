# discovery-core

Core discovery logic for the privacy pool, including storage slot computation and a simple RPC backend for testing and benchmarking.

## Test Vectors

Test vectors are generated from the Cairo contract. To regenerate:

```bash
# Generate and update the JSON fixture
cd sdk && npx tsx scripts/generate-cairo-refs.ts

# Copy to discovery-core
cp sdk/tests/fixtures/cairo-reference-data.json crates/discovery-core/tests/fixtures/
```

This runs the Cairo tests in `packages/privacy/src/tests/generate_reference_data.cairo` and updates `tests/fixtures/cairo-reference-data.json` with reference hash values.
