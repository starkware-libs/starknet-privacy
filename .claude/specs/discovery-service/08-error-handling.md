# 8. Error Handling

## 8.1 Error Response Format

All error responses follow a consistent structure:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "details": { }
  }
}
```

**HTTP status codes:**

- `400` - Client errors (invalid input, validation failures)
- `404` - Resource not found
- `409` - Conflict (reorg detected)
- `429` - Rate limited
- `500` - Internal server error
- `503` - Service unavailable (RPC unavailable)

## 8.2 Error Codes

| Code | HTTP Status | Retryable | Description |
|------|-------------|-----------|-------------|
| `INVALID_REQUEST` | 400 | No | Malformed request body or missing required fields |
| `MAX_READS_EXCEEDED` | 400 | No | Requested `max_reads` exceeds allowed maximum |
| `DECRYPTION_FAILED` | 400 | No | Provided key could not decrypt channel/note data |
| `BLOCK_REORGED` | 409 | Yes | `last_known_block` was reorged out; client should re-sync |
| `RATE_LIMITED` | 429 | Yes | Too many requests. `Retry-After` header is set by the reverse proxy, not the service itself |
| `SERVICE_UNAVAILABLE` | 503 | Yes | Service is starting up or no chain head available. `Retry-After` header, if present, is set by the reverse proxy |
| `RPC_UNAVAILABLE` | 503 | Yes | Upstream RPC is unavailable |
| `INTERNAL_ERROR` | 500 | Yes | Unexpected internal error |

## 8.4 Retry Guidance

Clients should implement exponential backoff for retryable errors:

- **Initial delay:** 1 second
- **Maximum delay:** 60 seconds
- **Backoff multiplier:** 2
- **Jitter:** +/-10%

For `BLOCK_REORGED` errors, clients should:

1. Reset the local state
2. Sync from scratch
