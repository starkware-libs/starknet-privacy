# 11. Reorg Handling

Cache correctness requires explicit reorg handling in the indexer.

## 11.1 Invariants

- Cache reflects a canonical chain state up to a chosen "safe head."
- Reorgs roll back cache updates for orphaned blocks before applying new canonical blocks.

## 11.2 Implementation Strategy

1. **Maintain a canonical chain cursor:** Track `(block_number, block_hash, parent_hash)` for ingested blocks.
2. **Detect reorg:** When the next block does not link to the current head by parent hash, a reorg is present.
3. **Find common ancestor:** Walk back the stored canonical chain until a matching ancestor hash is found.
4. **Roll back:** Delete keys associated with the reverted blocks.
5. **Apply new canonical blocks forward:** Ingest state updates for the new branch and apply diffs.

This logic is required regardless of the ingestion mechanism.

## 11.3 Reorg Depth Support

The current scheme supports arbitrary reorg depth because:

- The canonical blocks table stores complete parent hash linkage.
- Rollback deletes all entries above the common ancestor.
- During reorg reconciliation, the service falls back to RPC for any reads not yet re-indexed.

## 11.4 Request Handling During Reorg

When a reorg is in progress:

- Reads against rolled-back blocks return `BLOCK_REORGED` error.
- Reads against not-yet-indexed new blocks fall back to RPC (with stricter budget).
- Concurrent write operations are serialized at the indexer level.

## 11.5 Reorg-Related Errors

| Scenario | Error Code | Client Action |
|----------|------------|---------------|
| `block_ref` was reorged out | `BLOCK_REORGED` | Re-sync from scratch |
| `last_synced_block` was reorged out | `BLOCK_REORGED` | Re-sync from scratch |
| Current head is being reconciled | `SERVICE_UNAVAILABLE` | Retry with backoff |
