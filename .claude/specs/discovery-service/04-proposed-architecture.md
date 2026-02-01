# 4. Proposed Architecture

## 4.1 Components

**Discovery API (stateless):**

- Wallet-facing HTTP API.
- Implements bounded sync requests and cursors.

**Discovery engine:**

- Encodes traversal logic: channels -> subchannels -> notes -> nullifier checks.
- Enforces per-request read budgets.
- For each decrypted note, derives the nullifier and checks existence; returns only unspent notes.

**RPC adapter:**

- Performs direct `getStorageAt` reads against the RPC endpoint.
- Primary storage access method in the current implementation.

**Hot storage cache (future optimization):**

- Persistent read-optimized store, with atomic transactions.
- Contains only privacy pool contract state, sharded by block.
- Deferred to future implementation phase.

**Indexer backend (future optimization):**

- Ingests chain state updates from a single RPC endpoint.
- Extracts storage diffs relevant to the privacy pool contract.
- Writes batch to the hot cache.
- Deferred to future implementation phase.

## 4.2 Data Flow

**Current implementation (RPC-only):**

1. Discovery API receives request with cursor and read budget.
2. Discovery engine traverses channels/subchannels/notes via RPC adapter.
3. RPC adapter performs `getStorageAt` calls against the configured endpoint.

**Future implementation (with cache):**

1. Indexer ingests blocks, extracts storage diffs, updates cache.
2. Discovery API serves requests by reading from cache first.
3. If required (cold start, reorg), the API falls back to RPC reads with stricter budget.
