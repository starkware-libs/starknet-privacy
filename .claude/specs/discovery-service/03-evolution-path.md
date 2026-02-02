# 3. Evolution Path and Rationale

## Step 0: Naive Contract View Calls

**Approach:** Expose view functions that return channels, notes, and nullifier status through contract calls.

**Why this is weaker:**

- Moves heavy iteration into node execution and call responses, which increases operational and latency risk.
- Still requires many calls for nested iteration patterns.
- Requires smart contract upgrades for iterative performance improvements.

## Step 1: Direct Storage Access with Slot Computation

**Approach:** Use `getStorageAt` reads against computed storage slots rather than calling view functions.

**Benefits:**

- Eliminates contract execution overhead for discovery.
- Enables aggressive batching and parallel reads.

**Cost:**

- Requires correct storage slot calculation based on Cairo storage layout.
- Requires maintaining layout compatibility across contract upgrades.

This step is the correct primitive, but it still leaves wallets performing large numbers of reads.

## Step 2: Centralized Storage-Read Aggregation Service

**Approach:** Move slot computation, batching, probing, caching, and traversal logic into a dedicated service that wallets call.

**Benefits:**

- Wallets perform a small number of service requests per sync page.
- The service can batch upstream RPC calls and process multiple channels and subchannels in parallel.

A pure aggregator still depends on upstream RPC for most reads unless a local hot cache is introduced.

## Step 3: Local Node as an RPC Source

**Approach:** Run a local Starknet node and point the service to it.

**Benefits:**

- Improved reliability and throughput control.
- Reduced dependency on third-party provider limits.

**Why a node alone is insufficient:**

- The discovery workload remains dominated by repeated storage reads and probing patterns.
- A node does not remove repeated queries across users without an indexed cache.

## Step 4: Hot Indexed Cache from Storage Diffs, with RPC Fallback

**Approach:** Maintain a local database populated by ingesting per-block storage diffs. Serve discovery reads from the cache, and use RPC only for edge cases when the data is not actual.

**Benefits:**

- Converts the dominant workload from network-bound reads into local DB lookups.
- Reduces RPC usage to ingestion and fallback only.
- Enables predictable performance and straightforward horizontal scaling.

**This is the recommended end state.**
