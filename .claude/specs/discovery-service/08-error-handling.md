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
| `INVALID_ADDRESS` | 400 | No | Invalid Starknet address format |
| `INVALID_KEY_FORMAT` | 400 | No | Decryption key has invalid format |
| `INVALID_CURSOR` | 400 | No | Cursor structure is malformed |
| `INVALID_BLOCK_RANGE` | 400 | No | `block_ref` block number not greater than `last_synced_block` |
| `MAX_READS_EXCEEDED` | 400 | No | Requested `max_reads` exceeds allowed maximum |
| `BLOCK_NOT_FOUND` | 404 | No | Referenced `block_ref` does not exist |
| `BLOCK_REORGED` | 409 | Yes | Referenced `block_ref` was reorged out; client should re-sync |
| `DECRYPTION_FAILED` | 400 | No | Provided key could not decrypt any channels/notes |
| `RATE_LIMITED` | 429 | Yes | Too many requests; retry after `Retry-After` header |
| `SERVICE_UNAVAILABLE` | 503 | Yes | Service is starting up or backfilling; retry after `Retry-After` header |
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
