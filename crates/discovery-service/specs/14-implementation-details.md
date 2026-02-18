# 14. Implementation Details

## 14.1 Store

**Requirements:**

- On-disk persistence with the working set fitting in RAM (rely on OS page cache).
- ACID transactions for per-block batch writes and atomic visibility of indexed blocks.
- Append-only writes with immutable values; no updates and no old/new value tracking.
- Fast deletion by block number or block range for reorg rollback.
- Low operational overhead and minimal extra services.

**Typical write flow:**

1. New block arrives; fetch state update and extract storage diffs for the privacy pool contract.
2. Start a single database transaction.
3. Insert block metadata (number, hash, parent hash).
4. Batch insert all newly written `(contract_address, storage_key, value, block_number)` entries.
5. Commit.

**Typical read flow:**

1. Compute storage slots via slot calculation and the current discovery cursor (channels, subchannels, notes, nullifiers).
2. Execute batched point lookups for sets of storage keys (parallel scanning across channels and subchannels).
3. Use direct range queries only where applicable (for example, internal iteration over recently ingested blocks).

**Options and rationale:**

- **Embedded KV stores (RocksDB, LMDB):** Fast point lookups, but block-range deletion requires an additional block to keys index and extra bookkeeping.
- **Postgres:** Strong SQL and easy block-range deletion, but requires operating an external service and is heavier than needed for an in-memory working set.
- **SQLite (recommended):** Embedded, ACID, WAL supports concurrent reads, straightforward block-range deletion, minimal operational overhead.

**Recommendation:** Use SQLite in WAL mode as the hot cache. Store each storage entry with the block number that introduced it and keep a canonical blocks table. Rollback deletes entries and blocks above the common ancestor in a single transaction.

**Future scaling:** If throughput requirements exceed SQLite's single-writer model or database size grows beyond practical limits, transitioning to PostgreSQL is a viable migration path.

## 14.2 Development Stack

- **Rust:** Common denominator in company, fast, typed, safe, rich Starknet libraries.
- **Tokio:** For async runtime.
- **Axum:** Tokio-compatible web server.

## 14.3 Additional Functionality

- Extensive logging (with sensitive field filtering per section 5.1).
- Sentry integration for error tracking.
- Health endpoint for Docker/uptime services.
- Status endpoint to show indexing status, current head, blocks behind.

## 14.4 Packaging

- Static binaries for Linux x86, macOS ARM.
- Docker image.
- Support for loading from database snapshots for faster cold start recovery.
