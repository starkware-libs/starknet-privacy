# 11. Reorg Handling

Cache correctness requires explicit reorg handling in the indexer.

§11.1 describes the canonicity check the service performs today. The sections
after it describe the rollback design for the planned local cache.

## 11.1 Canonicity Check (implemented)

A request carrying `last_known_block` is answered from two sources, in order.

1. **Reorg notifications.** The indexer's `starknet_subscribeNewHeads` subscription
   delivers new headers and `starknet_subscriptionReorg`, which names the first and
   last block of an orphaned range. Both feed a bounded window of recent block
   hashes (1024 canonical + 1024 orphaned, hard capped since the node supplies
   them). An announced hash is canonical; a hash inside a reported orphaned range
   is not. Neither answer costs an RPC call.

   The window, and the cached head with it, is dropped when a subscription is
   **lost** rather than when one starts: reorgs reach live subscribers only and
   reconnection retries indefinitely, so anything the dead stream announced must go
   back to the node for the whole outage.

   **Trust assumption.** Treating an announced hash as canonical relies on the node
   reporting every range it takes back. A node that silently reorgs and then
   announces a header above the replaced height leaves the superseded entry
   canonical until it is evicted. The negative answer and the round trip in (2)
   carry no such assumption. Linking each header to the tracked entry below it by
   `parent_hash` and cutting a divergent prefix would remove it; §11.3 already
   tracks `parent_hash` for the planned cache.

2. **Hash → height → hash round trip.** For hashes the window does not cover,
   `starknet_getBlockWithTxHashes` resolves the hash to its block number, and a
   second call resolves that number to the block the node currently carries. The
   hashes must match. Existence is deliberately not the test: a node keeps serving
   an orphaned block by hash while its storage holds it, so a block that was
   *replaced* rather than dropped would otherwise read as canonical. Uncovered
   hashes therefore cost two round trips, each taking a request permit in turn.

An evicted hash is reported as unknown, never as orphaned, so eviction degrades to
the round trip instead of forcing clients to re-sync. A height that resolves to a
pre-confirmed block reports "not canonical", since a pre-confirmed block carries no
hash. An RPC failure is an error rather than either verdict, so a client is never
told to re-sync because the node was unreachable.

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
