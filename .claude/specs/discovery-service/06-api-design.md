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
  "recipient_addr": "0x...",
  "private_key": "0x...",
  "block_ref": null,
  "last_known_block": "",
  "cursor": {
    "start_channel_index": 0,
    "channels": {
      "0x_channel_key": {
        "start_subchannel_index": 0,
        "subchannels": {
          "0x_token_address": {
            "start_note_index": 0
          }
        }
      }
    }
  },
  "max_reads": 2000
}
```

**Cursor fields:**

- `start_channel_index`: Index to start scanning channels from (inclusive). Initial value is 0.
- `start_subchannel_index`: Index to start scanning subchannels from (inclusive). Initial value is 0.
- `start_note_index`: Index to start scanning notes from (inclusive). Initial value is 0.

**Response:**

```json
{
  "head": { "block_number": 123456, "block_hash": "0x..." },
  "total_n_channels": 10,
  "channels": {
    "0x_channel_key_1": {
      "sender_addr": "0x...",
      "total_n_subchannels": 3,
      "subchannels": {
        "0x_token_address_1": {
          "total_n_notes": 50,
          "notes": [
            { "index": 1, "amount": "1000", "...": "..." }
          ]
        }
      }
    }
  },
  "cursor": {
    "start_channel_index": 5,
    "channels": {
      "0x_channel_key_1": {
        "start_subchannel_index": 3,
        "subchannels": {
          "0x_token_address_1": {
            "start_note_index": 10
          }
        }
      }
    }
  },
  "stats": { "reads_used": 2000 }
}
```

**Completion detection:** Clients compute done status by comparing cursor indices against totals:
- Channels done: `cursor.start_channel_index >= total_n_channels`
- Subchannels done: `cursor.channels[key].start_subchannel_index >= total_n_subchannels`
- Notes done: `cursor.channels[key].subchannels[token].start_note_index >= total_n_notes`

**User flow:** Call the sync method repeatedly until all channels, subchannels, and notes are synced (all indices reach their totals), wait for the new block, repeat.

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
