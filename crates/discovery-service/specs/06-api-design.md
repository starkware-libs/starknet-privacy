# 6. API Design

> **Note:** The current implementation uses direct RPC calls (`getStorageAt`) for all storage access. A SQLite hot cache and block indexer are deferred to future optimization phases.

## 6.1 Bounded Synchronous Requests

**Rationale:**

- Simplicity: no job creation, no polling, no job-store, no sticky routing.
- Bounded cost per request: predictable CPU and IO per request.
- Natural pagination: wallet loops until completion using a cursor.

Async jobs remain an option for extreme backfills, but they introduce operational complexity and scaling concerns, including state persistence, cross-replica coordination, and abuse mitigation.

## 6.2 Block Reference Parameter

All discovery methods accept a `block_ref` parameter — a block identifier that pins all storage reads to a specific chain state. It can be:

- A **block hash**: `"0x..."` — pins reads to a specific confirmed block.
- A **block number**: `12345` — pins reads to a specific block height.
- A **block tag**: `"latest"`, `"pre_confirmed"`, `"l1_accepted"` — pins reads to a dynamic head.

Clients may specify `block_ref` on any request, including the first. When omitted, the server resolves to the current head hash. Explicit values (hash, number, or tag) pass through to the RPC node as-is. On pagination, pass back the `block_ref` from the previous response to ensure consistent reads across pages.

**Consistency guarantees:**
- **Block hash**: Full consistency — all paginated reads are pinned to the exact same block state. Reorg detection via `last_known_block` works.
- **Block number**: Best-effort — reads are pinned to a block height, but reorg detection does not apply.
- **Block tag**: Best-effort — the underlying block may change between paginated requests. Suitable for one-shot queries.

The hash-based `block_ref` from a completed sync becomes the next session's `last_known_block`, reducing the search scope for future queries. If the final `block_ref` is not a block hash, it cannot be used for reorg detection.

**Validation rules:**

- If `block_ref` is null, the server resolves to the current head hash.
- If `block_ref` references an unknown block, the RPC call fails with an error.
- `block_ref` is not validated for canonicity — that check is done via `last_known_block`.

## 6.3 Global Cursor Persistence

Cursors are global across the discovery flow. Users must store the cursor until the next query to avoid rescanning channels, subchannels, and notes they already have.

Cursor integrity is not enforced server-side beyond structural validation. Invalid cursors (e.g., skipped indices, inconsistent state) are the client's problem - the server budget is capped regardless.

## 6.4 Finality Model

The service works with soft finality to provide updates as soon as possible. All queries operate against blocks that are `ACCEPTED_ON_L2`. This means:

- Notes may appear that are later reorged out.
- Clients should handle reorg errors gracefully and re-sync from scratch (simple strategy).

For use cases requiring stronger finality, clients should wait for L1 confirmation before acting on discovered notes.

## 6.5 Incoming Notes Discovery Endpoint

`POST /v1/sync/incoming_state`

A unified endpoint that discovers channels, subchannels, and notes in one call with a composite cursor. This is the primary endpoint for incoming notes discovery.

**Request:**

```json
{
  "contract_address": "0x...",
  "recipient_address": "0x...",
  "viewing_key": "0x...",
  "last_known_block": "0x...",
  "block_ref": "0x...",
  "cursor": {
    "last_channel_index": null,
    "channels": {
      "0x_sender_addr": {
        "channel_key": "0x...",
        "last_subchannel_index": null,
        "subchannels": {
          "0x_token_address": {
            "last_note_index": null
          }
        }
      }
    }
  }
}
```

- `contract_address`: The privacy pool contract address.
- `recipient_address`: The recipient's on-chain address.
- `viewing_key`: The recipient's private viewing key (used for server-side decryption). Validated against the on-chain public key for the given address.
- `last_known_block`: Optional. Block hash from last completed sync session. Used for reorg detection on first request. Server returns `409 BLOCK_REORGED` if this block is no longer canonical. Leave empty on fresh syncs or pagination requests.
- `block_ref`: Optional. Block identifier — a hex string (`"0x..."`), a block number (`12345`), or a tag (`"latest"`, `"pre_confirmed"`, `"l1_accepted"`). Pins storage reads to a specific block. When omitted, the server uses the current head hash.
- `cursor`: Composite `DiscoveryCursor` for pagination. Default (empty) on first request.

**Progress fields in cursor:**

- `last_channel_index`: Last fully processed channel index. `null` means start from beginning.
- `last_subchannel_index`: Last fully processed subchannel index within a channel.
- `last_note_index`: Last fully processed note index within a subchannel.

**Response:**

```json
{
  "block_ref": "0x...",
  "channels": [
    { "channel_key": "0x...", "sender_addr": "0x..." }
  ],
  "subchannels": [
    { "sender_addr": "0x...", "token": "0x..." }
  ],
  "notes": [
    { "sender_addr": "0x...", "token": "0x...", "index": 1, "note_id": "0x...", "amount": "1000", "salt": "12345", "block_number": 12345 }
  ],
  "cursor": {
    "channel_discovery_complete": false,
    "last_channel_index": 5,
    "channels": {
      "0x_sender_addr": {
        "channel_key": "0x...",
        "subchannel_discovery_complete": true,
        "last_subchannel_index": 3,
        "subchannels": {
          "0x_token_address": {
            "note_discovery_complete": true,
            "last_note_index": 10
          }
        }
      }
    }
  }
}
```

**Response fields:**

- `block_ref`: Block identifier pinning all reads. Pass back as `block_ref` in subsequent requests.
- `channels`: Discovered incoming channels (one per sender).
- `subchannels`: Discovered incoming subchannels (one per sender×token pair).
- `notes`: Discovered notes with sender and token context.
- `cursor`: Updated `DiscoveryCursor` for continuation.

**Completion:** Check `cursor.is_complete()` — when `channel_discovery_complete` is true and all channels/subchannels have their discovery complete flags set.

**User flow:**

1. **First request**: Send with `last_known_block` set to previous session's block hash (or empty if fresh sync). Optionally include `block_ref` to pin reads to a specific block.
2. **Pagination**: Pass back `block_ref` and `cursor` from response until complete.
3. **Store for next session**: If the final `block_ref` is a block hash, save it as your `last_known_block` for reorg detection. Block number or tag refs cannot be used for reorg detection.

**Note filtering:** For each decrypted note, the service derives the nullifier and checks if it exists in contract state. Only unspent notes (those whose nullifier does not exist) are included in the response.

**Note `block_number`:** The slot's `last_update_block` from the storage RPC (`get_storage_at` with the `IncludeLastUpdateBlock` flag). Note slots are write-once, so this equals the block in which the note was created. Clients use it to enforce the 10-block maturity rule before spending.

## 6.6 Outgoing Channel Sync Endpoint

Discovers all outgoing channels and subchannels for a sender. The server decrypts outgoing channel data using the sender's `viewing_key` to find recipients and their per-token subchannels. An optional `recipients` filter restricts discovery to specific recipients; recipients without an existing on-chain channel are returned with `precomputed: true`.

Uses the same `block_ref`/`last_known_block` reorg-detection pattern and composite `DiscoveryCursor` as the incoming sync endpoint (§6.5).

`POST /v1/sync/outgoing_state`

**Request:**

```json
{
  "contract_address": "0x...",
  "sender_address": "0x...",
  "viewing_key": "0x...",
  "last_known_block": "0x...",
  "block_ref": "0x...",
  "cursor": { ... },
  "recipients": ["0x...", "0x..."]
}
```

- `contract_address`: The privacy pool contract address.
- `sender_address`: The sender's on-chain address.
- `viewing_key`: The sender's private viewing key (used for server-side decryption of outgoing channel data). Validated against the on-chain public key for the given address.
- `last_known_block`: Optional. For reorg detection on first request of a new sync session.
- `block_ref`: Optional. Block identifier for consistent reads across requests. Can be specified on any request, including the first.
- `cursor`: Composite `DiscoveryCursor` for pagination. Default (empty) on first request.
- `recipients`: Optional. When set, only return channels for these recipient addresses.

**Response:**

```json
{
  "block_ref": "0x...",
  "channels": [
    {
      "recipient_addr": "0x...",
      "recipient_public_key": "0x...",
      "channel_key": "0x...",
      "precomputed": false
    }
  ],
  "subchannels": [
    {
      "recipient_addr": "0x...",
      "token": "0x...",
      "last_note_index": 0
    }
  ],
  "cursor": { ... }
}
```

- `block_ref`: Block identifier pinning all reads. Pass back as `block_ref` in subsequent requests.
- `channels`: Discovered outgoing channels (one per recipient). `precomputed: true` for recipients requested via `recipients` filter that don't yet have an on-chain channel.
- `subchannels`: Discovered subchannels (one per recipient×token pair). `last_note_index` is the last note index in the subchannel, or `null` if no notes exist.
- `cursor`: Updated cursor for continuation.

**Completion:** Check `cursor.is_complete()` — when all channel and subchannel discovery is done.

## 6.7 Preflight Check Endpoint

A non-paginated readiness check that reports what on-chain setup exists for a `(sender, recipient, token)` tuple. Performs at most 4 direct storage lookups — no scanning, no budget, no cursor.

`POST /v1/sync/preflight_check`

**Request:**

```json
{
  "contract_address": "0x...",
  "sender_address": "0x...",
  "viewing_key": "0x...",
  "recipient": "0x...",
  "token": "0x..."
}
```

- `contract_address`: The privacy pool contract address.
- `sender_address`: The sender's on-chain address.
- `viewing_key`: The sender's private viewing key (used to derive channel key). Validated against the on-chain public key for the given address.
- `recipient`: The recipient's on-chain address.
- `token`: The token address to check subchannel for.

**Response:**

```json
{
  "block_ref": "0x...",
  "sender_registered": true,
  "channel_exists": true,
  "subchannel_exists": true
}
```

- `block_ref`: Block identifier pinning the reads. Clients can use this for consistency.
- `sender_registered`: Whether the sender has a public key registered on-chain.
- `channel_exists`: Whether the channel from sender to recipient exists. Always `false` if `sender_registered` is `false`.
- `subchannel_exists`: Whether the token subchannel exists within the channel. Always `false` if `channel_exists` is `false`.

**Error responses:**

- `503 SERVICE_UNAVAILABLE` — No block indexed yet.
- `500 INTERNAL_ERROR` — Failed to create RPC snapshot.
- Standard `DiscoveryError` mapping for storage errors.

## 6.8 History Endpoint

`POST /v1/history`

Retrieves paginated transaction history by scanning backward through note subchannels. Unlike the sync endpoints which discover channels and return current unspent notes, this endpoint operates on already-discovered subchannels and returns full transaction records including deposits, withdrawals, and both spent/unspent notes.

**Prerequisites:** The client must first complete incoming and/or outgoing sync to discover channel keys and subchannel metadata. The history cursor is built client-side from those sync results.

**Request:**

```json
{
  "contract_address": "0x...",
  "user_address": "0x...",
  "max_transactions": 50,
  "last_known_block": "0x...",
  "block_ref": "0x...",
  "cursor": {
    "subchannels": [
      {
        "channel_key": "0x...",
        "token": "0x...",
        "channel_kind": "incoming",
        "counterparty": "0x...",
        "next_index": 5
      }
    ],
    "begin_block_number": 0,
    "history_complete": false
  }
}
```

- `contract_address`: The privacy pool contract address.
- `user_address`: The user's on-chain address (used for withdrawal event filtering).
- `max_transactions`: Maximum number of transactions to return per page. Capped by server `max_history_transactions` limit.
- `last_known_block`: Optional. Block hash from last completed sync session. Used for reorg detection on first request.
- `block_ref`: Optional. Block identifier for consistent storage reads across requests. Can be specified on any request, including the first.
- `cursor`: History cursor for pagination.
  - `subchannels`: List of subchannels to scan. Each contains the `channel_key`, `token`, `channel_kind` (`incoming`, `outgoing`, `self_channel`), `counterparty` address, and `next_index` (next note index to read descending, `null` if exhausted).
  - `begin_block_number`: Inclusive upper bound for the next scan window. Set to `0` on first request (server resolves from chain head). On subsequent requests, use the value from the previous response cursor — note this may land partway through a long gap above a note, since the gap is scanned in budget-bounded windows (see Cursor lifecycle).
  - `history_complete`: `false` on initial request.

**Response:**

```json
{
  "block_ref": "0x...",
  "transactions": [
    {
      "block_number": 100,
      "transaction_hash": "0x...",
      "notes": [
        {
          "channel_kind": "incoming",
          "token": "0x...",
          "note_index": 0,
          "note_id": "0x...",
          "counterparty": "0x...",
          "amount": "1000",
          "salt": "12345"
        }
      ],
      "deposits": [
        { "user_address": "0x...", "token": "0x...", "amount": "1000" }
      ],
      "withdrawals": [],
      "open_note_deposits": []
    }
  ],
  "cursor": {
    "subchannels": [ ... ],
    "begin_block_number": 50,
    "history_complete": false
  }
}
```

- `block_ref`: Block identifier pinning all storage reads. Pass back as `block_ref` in subsequent requests.
- `transactions`: Transactions sorted by `block_number` descending. Each contains matched notes, deposits, withdrawals, and open note deposits from the same transaction.
- `cursor`: Updated cursor for continuation. Pass back in next request.

**Completion:** Check `cursor.history_complete` — `true` when all subchannels are exhausted.

**Cursor lifecycle:**

1. **Build initial cursor:** After completing incoming/outgoing sync, build `HistorySubchannel` entries from discovered channels and subchannels. Set `begin_block_number` to `0` and `history_complete` to `false`.
2. **First request:** Server resolves `begin_block_number` from chain head. For each note block (newest first) it scans the gap **above** it for standalone withdrawals first, then the note block's own events, advancing `begin_block_number` as each step commits.
3. **Pagination:** Pass back cursor from response. Server continues scanning from where it left off.
4. **Done:** When `history_complete` is `true`, all history has been retrieved.

**Chunked gap scan.** Standalone withdrawals (full withdrawals that create no note) live in the gap between note blocks and are found via a block-range `get_withdrawal_events` query. To keep per-request work bounded, the gap above each note is scanned **top-down in budget-bounded windows** (`COST_EVENTS_CHUNK` per `EVENTS_COST_CHUNK_SIZE`-block chunk, granting as many whole chunks as the remaining budget allows) rather than as one indivisible charge. Consequences:

- An account whose most-recent note is far behind chain head no longer fails with an oversized single charge; the wide gap is traversed across pages with forward progress, so the request returns `200` and the cursor advances.
- A page may therefore return **few or zero transactions** while still advancing `begin_block_number` through a long stretch with no activity. Clients must keep paginating until `history_complete` is `true` rather than treating an empty page as the end.
- The gap window is always strictly **above** the note block it anchors, so a withdrawal in a note's own block is attributed once (via that block's events) and never re-scanned by a later page's gap.
- One gap window can attach every withdrawal it contains at once, so a page covering a withdrawal-dense range may return **more than `max_transactions`** transactions. `max_transactions` is a per-page target, not a hard cap on a single page's size.
- A page that can make **no** forward progress (the budget covers neither a gap chunk nor the next note step) returns `500 INTERNAL_ERROR` rather than an endless stream of empty `200`s. This only occurs when `server_budget` is set too low for the account's per-request cost (e.g. many subchannels); raise `server_budget`.

**Validation limits:**

- `max_history_subchannels` (default: 256): Maximum number of subchannels in a history cursor.
- `max_history_transactions` (default: 100): Maximum allowed `max_transactions` value.

**Error responses:**

- `400 INVALID_REQUEST` — Cursor exceeds size limits, or `max_transactions` exceeds server limit.
- `409 BLOCK_REORGED` — `last_known_block` was reorged out.
- `503 SERVICE_UNAVAILABLE` — No indexed head available yet.
- Standard `DiscoveryError` mapping for storage and event errors.
