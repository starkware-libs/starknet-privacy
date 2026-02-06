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

## 6.5 Incoming State Sync Endpoint

`POST /v1/sync/incoming_state`

A unified endpoint that discovers channels, subchannels, and notes in one call with a composite cursor. This is the primary endpoint for incoming notes discovery.

**Request:**

```json
{
  "recipient_address": "0x...",
  "decryption_key": "0x...",
  "last_known_block": "0x...",
  "block_ref": "0x...",
  "cursor": {
    "skip_channel_discovery": false,
    "total_n_channels": 100,
    "last_channel_index": 5,
    "channels": {
      "0x_sender_addr": {
        "channel_key": "0x...",
        "skip_subchannel_discovery": true,
        "last_subchannel_index": 2,
        "subchannels": {
          "0x_token_address": {
            "last_note_index": 3,
            "max_note_index": 10
          }
        }
      }
    }
  },
  "max_reads": 50
}
```

**Top-level request fields:**

- `recipient_address`: Starknet address of the recipient.
- `decryption_key`: Key used to decrypt channel data.
- `last_known_block`: Block hash from last completed sync session. Used for reorg detection on the first request of a new session. Server returns `409 BLOCK_REORGED` if this block is no longer canonical. Omit on fresh syncs or pagination requests.
- `block_ref`: Block hash to query state at. Ensures consistent reads across paginated requests. Omit on first request (server resolves current head and returns it in the response).
- `cursor`: Discovery pagination state (see below). Omit or send `{}` on first request.
- `max_reads`: Maximum number of storage reads per request. Defaults to 50, capped at 100.

**Cursor fields:**

- `skip_channel_discovery`: When `true`, only processes channels already in the cursor — use this after channel discovery is complete. Defaults to `false`.
- `total_n_channels`: Cached total channel count. Populated by the server after the first channel-count fetch. Avoids re-fetching on subsequent pages.
- `last_channel_index`: Last fully processed channel index. Omit to start from the beginning.
- `channels`: Map of in-progress channels keyed by **sender address**. Each channel entry contains:
  - `channel_key`: The channel key for this channel.
  - `skip_subchannel_discovery`: When `true`, only processes subchannels already in the cursor (skips discovery of new subchannels).
  - `last_subchannel_index`: Last fully processed subchannel index.
  - `subchannels`: Map of in-progress subchannels keyed by token address, each with:
    - `last_note_index`: Last scanned note index.
    - `max_note_index`: Last index confirmed to exist by exponential probe. Linear scan reads notes up to this index. Re-probe triggers when `last_note_index == max_note_index`.

All cursor fields are optional and omitted when empty/null, keeping the cursor compact.

**Response:**

```json
{
  "block_ref": "0x...",
  "channels": {
    "0x_sender_addr": {
      "channel_key": "0x...",
      "subchannels": {
        "0x_token_address": [
          { "index": 1, "note_id": "0x...", "amount": 1000, "salt": 42 }
        ]
      }
    }
  },
  "cursor": { "..." }
}
```

**Response fields:**

- `block_ref`: Block hash pinning all reads in this response. Pass back as-is on pagination requests. Use as `last_known_block` for the next sync session.
- `channels`: Discovered data for this page, keyed by **sender address**. Each channel contains `channel_key` and `subchannels` (a map of token address to arrays of decrypted notes). Each note has `index`, `note_id`, `amount`, and `salt`.
- `cursor`: Updated pagination state. Pass back as-is on the next request.

**Completion detection:** Discovery is complete when `cursor.channels` is empty (all channels and subchannels have been fully processed and pruned from the cursor).

**User flow:**

1. **First request**: Send `last_known_block` (from previous session's `block_ref`, or omit for fresh sync). Omit `block_ref` and `cursor`.
2. **Pagination**: Pass back `block_ref` and `cursor` from the response as-is.
3. **Done**: When `cursor.channels` is empty, all discovery is complete. Store `block_ref` as `last_known_block` for the next session.

**Future: Note filtering.** For each decrypted note, the service will derive the nullifier and check if it exists in contract state. Only unspent notes (those whose nullifier does not exist) will be included in the response. This is not yet implemented.

## 6.6 Outgoing State Sync Endpoint

`POST /v1/sync/outgoing_state`

Discovers all outgoing channels for a sender, their subchannels, and the last note index in each subchannel. Uses the same cursor structure as the incoming endpoint, but channels are keyed by **recipient address** and subchannels contain `last_note_index` (the last used note index) instead of decrypted notes.

**Request:**

```json
{
  "sender_address": "0x...",
  "viewing_key": "0x...",
  "last_known_block": "0x...",
  "block_ref": "0x...",
  "cursor": {
    "skip_channel_discovery": false,
    "total_n_channels": null,
    "last_channel_index": null,
    "channels": {}
  },
  "max_reads": 50
}
```

**Top-level request fields:**

- `sender_address`: The sender's Starknet address.
- `viewing_key`: The sender's private viewing key (used to derive outgoing channel IDs and decrypt recipient addresses).
- `last_known_block`, `block_ref`, `cursor`, `max_reads`: Same semantics as incoming (§6.5).

**Response:**

```json
{
  "block_ref": "0x...",
  "channels": {
    "0x_recipient_addr": {
      "channel_key": "0x...",
      "subchannels": {
        "0x_token_address": 5
      }
    }
  },
  "cursor": { "..." }
}
```

**Response fields:**

- `block_ref`: Block hash pinning all reads.
- `channels`: Discovered outgoing channels keyed by **recipient address**. Each channel contains:
  - `channel_key`: The channel key for this outgoing channel.
  - `subchannels`: Map of token address to `Option<u64>` — the last used note index (`null` if subchannel has no notes yet).
- `cursor`: Updated pagination state (same structure as incoming cursor).

**Completion detection:** Same as incoming — `cursor.channels` empty means all outgoing channels are fully discovered.

## 6.7 Preflight Endpoint

`POST /v1/discovery/preflight`

Checks what setup is needed before a sender can transfer a specific token to a specific recipient. Returns three boolean flags indicating the current setup state. Always queries at the latest indexed head (no `block_ref`/cursor — constant scope of at most 4 storage reads).

**Request:**

```json
{
  "sender_address": "0x...",
  "viewing_key": "0x...",
  "recipient": "0x...",
  "token": "0x..."
}
```

**Response:**

```json
{
  "block_ref": "0x...",
  "sender_registered": true,
  "channel_exists": true,
  "subchannel_exists": true
}
```

**Response fields:**

- `block_ref`: Block hash pinning the reads.
- `sender_registered`: Whether the sender has a public key registered on-chain. If `false`, the remaining flags are always `false` (can't derive channel key without sender registration).
- `channel_exists`: Whether the channel from sender to recipient exists. Requires both sender and recipient to be registered. If the recipient is not registered, this is `false`.
- `subchannel_exists`: Whether the token subchannel exists within the channel. Only `true` when both `sender_registered` and `channel_exists` are `true`.

**Algorithm (4 direct storage lookups, no scanning):**

1. `get_public_key(sender)` → if zero: `sender_registered=false`, done.
2. `get_public_key(recipient)` → if zero: `channel_exists=false`, done.
3. Derive `channel_key` + `channel_marker` → `channel_exists(marker)` → if false: `channel_exists=false`, done.
4. Derive `subchannel_marker` → `subchannel_exists(marker)`.

## 6.8 History Endpoint (Not Yet Specified)

`POST /v1/discovery/history`

A planned endpoint for full history retrieval. Unlike the sync endpoints which focus on current unspent notes, this endpoint will provide:

- Full history of all notes (both spent and unspent)
- Both sent and received notes
- Historical transaction data for audit/reporting purposes

**Status:** Not yet specified. This section is a placeholder for future design work.
