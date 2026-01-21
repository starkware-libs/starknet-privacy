# discovery-core

Core discovery logic for the privacy pool, including storage slot computation and a simple RPC backend for testing and benchmarking.

## Test Vectors

Test vectors are generated from the Cairo contract. To regenerate:

```bash
cd sdk
npm run generate:cairo-refs
cp tests/fixtures/cairo-reference-data.json ../crates/discovery-core/tests/fixtures/cairo-reference-data.json
```
