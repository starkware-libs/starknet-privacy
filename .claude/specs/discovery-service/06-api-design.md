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

`POST /v1/discovery/incoming/sync`

A unified endpoint that discovers channels, subchannels, and notes in one call with a composite cursor. This is the primary endpoint for incoming notes discovery.

**Request:**

```json
{
  "recipient_address": "0x...",
  "decryption_key": "0x...",
  "cursor": {
    "last_known_block": "0x...",
    "block_ref": null,
    "last_channel_index": null,
    "channels": {
      "0x_channel_key": {
        "last_subchannel_index": null,
        "subchannels": {
          "0x_token_address": {
            "last_note_index": null
          }
        }
      }
    }
  },
  "max_reads": 2000
}
```

**Block fields in cursor:**

- `last_known_block`: Block hash from last completed sync session. Used for reorg detection on first request. Server returns `409 BLOCK_REORGED` if this block is no longer canonical. Leave empty on fresh syncs or pagination requests.
- `block_ref`: Block hash to query state at. Ensures consistent reads across paginated requests. Leave empty on first request (server uses current head and sets it in response cursor).

**Progress fields in cursor:**

- `last_channel_index`: Last fully processed channel index. `null` means start from beginning.
- `last_subchannel_index`: Last fully processed subchannel index within a channel.
- `last_note_index`: Last fully processed note index within a subchannel.

**Response:**

```json
{
  "head": { "block_number": 123456, "block_hash": "0x...", "timestamp": 1234567890 },
  "channels_done": false,
  "channels": {
    "0x_channel_key_1": {
      "sender_addr": "0x...",
      "subchannels_done": true,
      "subchannels": {
        "0x_token_address_1": {
          "notes_done": true,
          "notes": [
            { "index": 1, "note_id": "0x...", "amount": 1000 }
          ]
        }
      }
    }
  },
  "cursor": {
    "block_ref": "0x...",
    "last_channel_index": 5,
    "channels": {
      "0x_channel_key_1": {
        "last_subchannel_index": 3,
        "subchannels": {
          "0x_token_address_1": {
            "last_note_index": 10
          }
        }
      }
    }
  },
  "stats": { "reads": 2000, "channels_discovered": 1, "subchannels_discovered": 2, "notes_discovered": 5 }
}
```

**Response fields:**

- `head`: Current chain head. Only present on first request (when `block_ref` not specified). Use `head.block_hash` as `last_known_block` for next sync session.
- `channels_done`, `subchannels_done`, `notes_done`: Server-computed completion status. When all are `true`, sync is complete.
- `cursor.block_ref`: Block hash used for queries. Automatically set by server. Pass back as-is on pagination requests.
- `cursor.last_known_block`: Always cleared in response cursor.

**User flow:**

1. **First request**: Send with `last_known_block` set to previous session's `head.block_hash` (or empty if fresh sync).
2. **Pagination**: Use response cursor as-is until `channels_done` is `true`.
3. **Store for next session**: Save final `head.block_hash` as your `last_known_block`.

**Note filtering:** For each decrypted note, the service derives the nullifier and checks if it exists in contract state. Only unspent notes (those whose nullifier does not exist) are included in the response.

## 6.6 Outgoing Channel Sync Endpoint

Whenever a user wants to make a private transfer there are several things to determine:

1. Is the sender registered in the pool?
2. Is the receiver registered in the pool?
3. Is there an existing outgoing channel for the destination address?
4. Is there an existing subchannel for the target token?
5. What is the latest note index in that subchannel (if it exists)?

The channel key is computed on the client using the viewing key. This avoids sending additional secrets to the service.

Typically users should have this information cached locally but in case there's a need to recover it, the following method would do all the checks and encrypted note discovery.

`POST /v1/discovery/outgoing/sync`

**Request:**

```json
{
  "sender_addr": "0x...",
  "recipient_addr": "0x...",
  "channel_key": "0x...",
  "token_address": "0x...",
  "block_ref": "0x...",
  "cursor": {
    "start_note_index": 0
  },
  "max_reads": 1000
}
```

**Response:**

```json
{
  "head": { "block_number": 123456, "block_hash": "0x..." },
  "sender_registered": true,
  "receiver_registered": true,
  "channel_exists": true,
  "subchannel_exists": true,
  "total_n_notes": 57,
  "cursor": {
    "start_note_index": 57
  },
  "stats": { "reads_used": 100 }
}
```

**Completion detection:** Client computes done status: `cursor.start_note_index >= total_n_notes`.

**Current limitation:** This endpoint supports a single receiver/token pair per request. Future versions may support batch queries for multiple receivers to enable mass payout scenarios.

## 6.7 History Endpoint (Not Yet Specified)

`POST /v1/discovery/history`

A planned endpoint for full history retrieval. Unlike the sync endpoints which focus on current unspent notes, this endpoint will provide:

- Full history of all notes (both spent and unspent)
- Both sent and received notes
- Historical transaction data for audit/reporting purposes

**Status:** Not yet specified. This section is a placeholder for future design work.
