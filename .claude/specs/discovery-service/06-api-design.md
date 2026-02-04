# 6. API Design

> **Note:** The current implementation uses direct RPC calls (`getStorageAt`) for all storage access. A SQLite hot cache and block indexer are deferred to future optimization phases.

## 6.1 Bounded Synchronous Requests

**Rationale:**

- Simplicity: no job creation, no polling, no job-store, no sticky routing.
- Bounded cost per request: predictable CPU and IO per request.
- Natural pagination: wallet loops until completion using a cursor.

Async jobs remain an option for extreme backfills, but they introduce operational complexity and scaling concerns, including state persistence, cross-replica coordination, and abuse mitigation.

## 6.2 Block Reference Parameter

All discovery methods accept a `block_ref` parameter (a block hash) to fix the head so that all requests within the current cursor "session" are queried against the same state.

**Validation rules:**

- If `block_ref` is absent, the service queries against the latest RPC head and returns the resolved block hash in the response.
- If `block_ref` is present, it is used as-is for querying (no separate existence check — an invalid hash surfaces as an RPC error).
- If `last_known_block` is provided (first request only), the service checks that it is still canonical. If reorged out, return error `BLOCK_REORGED`.

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
  "last_known_block": "0x...",
  "block_ref": "0x...",
  "cursor": {
    "total_n_channels": 100,
    "last_channel_index": 5,
    "channels": {
      "0x_channel_key": {
        "sender_addr": "0x...",
        "total_n_subchannels": 10,
        "last_subchannel_index": 2,
        "subchannels": {
          "0x_token_address": {
            "last_note_index": 3
          }
        }
      }
    }
  },
  "max_reads": 1000
}
```

**Top-level request fields:**

- `recipient_address`: Starknet address of the recipient.
- `decryption_key`: Key used to decrypt channel data.
- `last_known_block`: Block hash from last completed sync session. Used for reorg detection on the first request of a new session. Server returns `409 BLOCK_REORGED` if this block is no longer canonical. Omit on fresh syncs or pagination requests.
- `block_ref`: Block hash to query state at. Ensures consistent reads across paginated requests. Omit on first request (server resolves current head and returns it in the response).
- `cursor`: Discovery pagination state (see below). Omit or send `{}` on first request.
- `max_reads`: Maximum number of storage reads per request. Defaults to 1000, capped at 5000.

**Cursor fields:**

- `total_n_channels`: Cached total channel count. Populated by the server after the first channel-count fetch. Avoids re-fetching on subsequent pages.
- `last_channel_index`: Last fully processed channel index. Omit to start from the beginning.
- `channels`: Map of in-progress channels keyed by channel key. Each channel entry contains:
  - `sender_addr`: Sender address for this channel.
  - `total_n_subchannels`: Cached total subchannel count for this channel.
  - `last_subchannel_index`: Last fully processed subchannel index.
  - `subchannels`: Map of in-progress subchannels keyed by token address, each with:
    - `last_note_index`: Last fully processed note index.

All cursor fields are optional and omitted when empty/null, keeping the cursor compact.

**Response:**

```json
{
  "block_ref": "0x...",
  "channels": {
    "0x_channel_key_1": {
      "sender_addr": "0x...",
      "subchannels": {
        "0x_token_address_1": [
          { "index": 1, "note_id": "0x...", "amount": 1000 }
        ]
      }
    }
  },
  "cursor": {
    "total_n_channels": 100,
    "last_channel_index": 10,
    "channels": {
      "0x_channel_key_1": {
        "sender_addr": "0x...",
        "total_n_subchannels": 5,
        "last_subchannel_index": 3,
        "subchannels": {
          "0x_token_address_1": {
            "last_note_index": 10
          }
        }
      }
    }
  }
}
```

**Response fields:**

- `block_ref`: Block hash pinning all reads in this response. Pass back as-is on pagination requests. Use as `last_known_block` for the next sync session.
- `channels`: Discovered data for this page — channels with their subchannels and decrypted notes.
- `cursor`: Updated pagination state. Pass back as-is on the next request.

**Completion detection:** Discovery is complete when `cursor.channels` is empty (all channels and subchannels have been fully processed and pruned from the cursor).

**User flow:**

1. **First request**: Send `last_known_block` (from previous session's `block_ref`, or omit for fresh sync). Omit `block_ref` and `cursor`.
2. **Pagination**: Pass back `block_ref` and `cursor` from the response as-is.
3. **Done**: When `cursor.channels` is empty, all discovery is complete. Store `block_ref` as `last_known_block` for the next session.

**Future: Note filtering.** For each decrypted note, the service will derive the nullifier and check if it exists in contract state. Only unspent notes (those whose nullifier does not exist) will be included in the response. This is not yet implemented.

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
