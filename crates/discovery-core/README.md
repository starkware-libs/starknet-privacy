# discovery-core

Core discovery logic for the privacy pool, including storage slot computation and a simple RPC backend for testing and benchmarking.

## Test Vectors

Test vectors are generated from the Cairo contract. To regenerate:

```bash
cd packages/privacy && snforge test generate_storage_slots --include-ignored
```

See `packages/privacy/src/tests/generate_reference_hashes.cairo` for the generation code.
