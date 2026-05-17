# 8. Error Handling

## 8.1 Error Response Format

All error responses follow a consistent structure:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "details": { },
    "request_id": "request-id-echoed-from-header"
  }
}
```

`request_id` echoes the value of the `x-request-id` response header (and the inbound request header when the client supplied one; otherwise a server-generated UUID). It is omitted from the body when no id is bound to the request. Clients should include this id when reporting an error so the corresponding server-side logs can be located.

**HTTP status codes:**

- `400` - Client errors (invalid input, validation failures)
- `409` - Conflict (reorg detected)
- `429` - Rate limited
- `500` - Internal server error
- `503` - Service unavailable (RPC unavailable)

## 8.2 Error Codes

| Code | HTTP Status | Retryable | Description |
|------|-------------|-----------|-------------|
| `INVALID_REQUEST` | 400 | No | Malformed request body or missing required fields |
| `MAX_READS_EXCEEDED` | 400 | No | Requested `max_reads` exceeds allowed maximum |
| `DECRYPTION_FAILED` | 400 | No | Provided key could not decrypt channel/note data. Generic message only — channel index and internal error details are logged server-side, not exposed to the client |
| `CONTRACT_NOT_FOUND` | 400 | No | Contract not found at the provided address |
| `BLOCK_REORGED` | 409 | Yes | `last_known_block` was reorged out; client should re-sync |
| `RATE_LIMITED` | 429 | Yes | Too many requests. `Retry-After` header is set by the reverse proxy, not the service itself |
| `SERVICE_UNAVAILABLE` | 503 | Yes | Service is starting up or no chain head available. `Retry-After` header, if present, is set by the reverse proxy |
| `RPC_UNAVAILABLE` | 503 | Yes | Upstream RPC is unavailable |
| `INTERNAL_ERROR` | 500 | Yes | Unexpected internal error. RPC/storage error details are logged server-side, not forwarded to the client |

## 8.3 Server-Side Logging

Every error response has a paired log line emitted at the point the error is detected (validators, snapshot acquisition, discovery engine, JSON body extraction). The mapping helpers from error → HTTP response are pure: they do not log, so each error is recorded exactly once.

**Level policy:**

- `INFO` — client-driven 4xx errors (bad cursor, mismatched viewing key, decryption failure, `CONTRACT_NOT_FOUND`, JSON deserialization rejection, reorged `last_known_block`). These are expected outcomes of invalid input and would flood production logs at `WARN`.
- `WARN` — server-side / unexpected failures (RPC unavailable, storage backend errors not caused by user input, internal discovery errors, no indexed head yet, panicked tasks, I/O budget overflow).

**Body extraction errors** (malformed or missing JSON, missing required fields) are routed through a custom `ApiJson<T>` extractor that returns the standard `ApiErrorResponse` body (with `request_id` attached) rather than axum's default `text/plain` rejection. The rejection reason is logged at `INFO`.

Every log line for a failed request inherits the `request_id` field from the surrounding `http_request` span, so a client-supplied `x-request-id` (or the server-generated UUID) is sufficient to pull all server-side logs for a single failure.

## 8.4 Retry Guidance

Clients should implement exponential backoff for retryable errors:

- **Initial delay:** 1 second
- **Maximum delay:** 60 seconds
- **Backoff multiplier:** 2
- **Jitter:** +/-10%

For `BLOCK_REORGED` errors, clients should:

1. Reset the local state
2. Sync from scratch
