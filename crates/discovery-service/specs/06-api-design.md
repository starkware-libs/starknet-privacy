# 6. API Design

> **Note:** The current implementation uses direct RPC calls (`getStorageAt`) for all storage access. A SQLite hot cache and block indexer are deferred to future optimization phases.

## 6.1 Bounded Synchronous Requests

**Rationale:**

- Simplicity: no job creation, no polling, no job-store, no sticky routing.
- Bounded cost per request: predictable CPU and IO per request.
- Natural pagination: wallet loops until completion using a cursor.

Async jobs remain an option for extreme backfills, but they introduce operational complexity and scaling concerns, including state persistence, cross-replica coordination, and abuse mitigation.

## 6.2 Block Reference Parameter

All discovery methods accept a `block_ref` parameter (a block hash) to fix the head so that all requests within the current cursor "session" are queried against the same state. This block must have a block number greater than `last_synced_block`.

The `block_ref` becomes the next sync's `last_synced_block`, reducing the search scope for future queries.

**Validation rules:**

- If `block_ref` is null, the service queries against the latest RPC head.
- If `block_ref` references an unknown block, return error `BLOCK_NOT_FOUND`.
- If `block_ref` references a block that has been reorged out, return error `BLOCK_REORGED`.
- If `block_ref` block number is not greater than `last_synced_block` block number, return error `INVALID_BLOCK_RANGE`.

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
- `block_ref`: Optional. Block hash to query state at. Ensures consistent reads across paginated requests. Leave empty on first request (server uses current head and sets it in response).
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
    { "sender_addr": "0x...", "token": "0x...", "index": 1, "note_id": "0x...", "amount": 1000, "salt": 12345 }
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

- `block_ref`: Block hash pinning all reads. Pass back as `block_ref` in subsequent requests.
- `channels`: Discovered incoming channels (one per sender).
- `subchannels`: Discovered incoming subchannels (one per sender×token pair).
- `notes`: Discovered notes with sender and token context.
- `cursor`: Updated `DiscoveryCursor` for continuation.

**Completion:** Check `cursor.is_complete()` — when `channel_discovery_complete` is true and all channels/subchannels have their discovery complete flags set.

**User flow:**

1. **First request**: Send with `last_known_block` set to previous session's block hash (or empty if fresh sync).
2. **Pagination**: Pass back `block_ref` and `cursor` from response until complete.
3. **Store for next session**: Save final `block_ref` as your `last_known_block`.

**Note filtering:** For each decrypted note, the service derives the nullifier and checks if it exists in contract state. Only unspent notes (those whose nullifier does not exist) are included in the response.

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
- `block_ref`: Optional. Block hash for consistent reads across paginated requests.
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

- `block_ref`: Block hash pinning all reads. Pass back as `block_ref` in subsequent requests.
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

- `block_ref`: Block hash pinning the reads. Clients can use this for consistency.
- `sender_registered`: Whether the sender has a public key registered on-chain.
- `channel_exists`: Whether the channel from sender to recipient exists. Always `false` if `sender_registered` is `false`.
- `subchannel_exists`: Whether the token subchannel exists within the channel. Always `false` if `channel_exists` is `false`.

**Error responses:**

- `503 SERVICE_UNAVAILABLE` — No block indexed yet.
- `500 INTERNAL_ERROR` — Failed to create RPC snapshot.
- Standard `DiscoveryError` mapping for storage errors.

## 6.8 History Endpoint (Not Yet Specified)

`POST /v1/discovery/history`

A planned endpoint for full history retrieval. Unlike the sync endpoints which focus on current unspent notes, this endpoint will provide:

- Full history of all notes (both spent and unspent)
- Both sent and received notes
- Historical transaction data for audit/reporting purposes

**Status:** Not yet specified. This section is a placeholder for future design work.
