# 11. Reorg Handling

Cache correctness requires explicit reorg handling in the indexer.

§11.1 describes the canonicity check the service performs today. The sections
after it describe the rollback design for the planned local cache.

## 11.1 Canonicity Check (implemented)

A request carrying `last_known_block` is answered by a **hash → height → hash
round trip**: `starknet_getBlockWithTxHashes` resolves the hash to its block
number, and a second call resolves that number to the block the node currently
carries. The hashes must match.

The second call is skipped when the first reports `ACCEPTED_ON_L1`: that block's
state update is finalized on Ethereum, so no reorg can replace it and the height
lookup cannot change the answer. Cursors older than L1 finality — measured at
roughly 1.5k blocks behind head on Sepolia — therefore cost one round trip rather
than two.

Existence is deliberately not used as the test: a node keeps serving an orphaned
block by hash while its storage holds it, so a block that was *replaced* rather
than merely dropped would otherwise be reported as canonical. A height, by
contrast, addresses exactly one block. Each check therefore costs two RPC round
trips, each taking a request permit in turn.

A height that resolves to a pre-confirmed block reports "not canonical", since a
pre-confirmed block carries no hash and so can never be the hash asked about. An
RPC failure is reported as an error rather than as either verdict, so a client is
never told to re-sync because the node was unreachable.

## 11.2 Invariants

- Cache reflects a canonical chain state up to a chosen "safe head."
- Reorgs roll back cache updates for orphaned blocks before applying new canonical blocks.

## 11.3 Implementation Strategy

1. **Maintain a canonical chain cursor:** Track `(block_number, block_hash, parent_hash)` for ingested blocks.
2. **Detect reorg:** When the next block does not link to the current head by parent hash, a reorg is present.
3. **Find common ancestor:** Walk back the stored canonical chain until a matching ancestor hash is found.
4. **Roll back:** Delete keys associated with the reverted blocks.
5. **Apply new canonical blocks forward:** Ingest state updates for the new branch and apply diffs.

This logic is required regardless of the ingestion mechanism.

## 11.4 Reorg Depth Support

The current scheme supports arbitrary reorg depth because:

- The canonical blocks table stores complete parent hash linkage.
- Rollback deletes all entries above the common ancestor.
- During reorg reconciliation, the service falls back to RPC for any reads not yet re-indexed.

## 11.5 Request Handling During Reorg

When a reorg is in progress:

- Reads against rolled-back blocks return `BLOCK_REORGED` error.
- Reads against not-yet-indexed new blocks fall back to RPC (with stricter budget).
- Concurrent write operations are serialized at the indexer level.

## 11.6 Reorg-Related Errors

| Scenario | Error Code | Client Action |
|----------|------------|---------------|
| `block_ref` was reorged out | `BLOCK_REORGED` | Re-sync from scratch |
| `last_synced_block` was reorged out | `BLOCK_REORGED` | Re-sync from scratch |
| Current head is being reconciled | `SERVICE_UNAVAILABLE` | Retry with backoff |
