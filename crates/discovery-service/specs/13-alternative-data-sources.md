# 13. Alternative Data Sources

## 13.1 Contract Events for Channels, Notes, Nullifiers

**Benefits:**

- No storage slot computation for consumers.
- Natural indexing stream, useful for analytics and other applications.

**Costs:**

- Requires smart contract changes and deployments.
- Adds additional event schema and code paths.
- Increases maintenance burden and introduces new failure modes in event decoding and indexing.
- May add overhead to execution and indexing pipelines.

Events remain a viable option, but they are not required for the hybrid cache plus RPC fallback model.

## 13.2 Apibara as an Ingestion Option

Apibara can be used as a source of filtered chain data, including state updates, but it adds another infrastructure dependency. Reorg handling is still required in the indexer logic, and is not provided as a complete solution by the Rust SDK. Given that indexing can be implemented against a single RPC endpoint, Apibara may be unnecessary overhead for the initial system.
