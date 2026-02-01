# 17. Cold Start and Backfill

## 17.1 Behavior During Backfill

When the service starts with an empty or stale cache:

1. The indexer begins backfilling from the last known block (or genesis/configured start block).
2. During backfill, all discovery requests fall back to RPC with stricter budget limits.
3. The health endpoint reports `backfill_in_progress: true`.
4. Clients may receive `SERVICE_UNAVAILABLE` with `Retry-After` header if RPC capacity is exhausted.

## 17.2 Snapshot Support

To accelerate recovery, the service SHOULD support loading from database snapshots:

**Export:** Periodic snapshots of the SQLite database can be taken and stored.

**Import:** On cold start, if a snapshot is available:

1. Load snapshot into database.
2. Verify snapshot integrity (block hash chain validation).
3. Resume indexing from snapshot head.

**Snapshot format:** SQLite database file, optionally compressed.

**Distribution:** Snapshots can be distributed via object storage (S3, GCS) or peer-to-peer mechanisms.

## 17.3 Backfill Time Estimation

Backfill time depends on:

- Number of blocks to process.
- RPC throughput limits.
- Storage diff density per block.

Concrete estimates require benchmarking against production data and are left as an open question for initial deployment.
