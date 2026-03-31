# Elliptic Proxy — Design

## Overview

A GCP Cloud Function (TypeScript/Node.js) that acts as a transparent proxy to
Elliptic's API. Third-party partners call it exactly as they would call Elliptic
(same headers, same HMAC signing). The proxy verifies the partner's signature,
re-signs with the real Elliptic credentials, and forwards the request. The
response is returned as-is.

## Request Flow

```
Partner → Cloud Function → Elliptic API
         1. Extract x-access-key, x-access-sign, x-access-timestamp
         2. Look up partner by name (x-access-key = partner name)
         3. Verify partner's HMAC signature
         4. Check rate limit
         5. Check request body size limit
         6. Re-sign with real Elliptic key + secret
         7. Forward request (path + body) to Elliptic
         8. Score Elliptic response and return blocked/allowed
```

## Configuration

A single JSON document stored in GCP Secret Manager
(`elliptic-proxy-config`). Updated via `gcloud secrets versions add` or GCP
Console — no redeploy needed. The proxy caches the config in memory and
re-reads it according to `cacheTtlSeconds`.

```json
{
  "elliptic": {
    "url": "https://api.elliptic.co",
    "key": "real-elliptic-api-key",
    "secret": "real-elliptic-hmac-secret-base64",
    "timeoutMs": 10000
  },
  "rateLimitPerMinute": 100,
  "maxBodyBytes": 10240,
  "cacheTtlSeconds": 300,
  "partners": {
    "partner-a": "issued-hmac-secret-base64",
    "partner-b": "issued-hmac-secret-base64"
  }
}
```

### Configuration fields

| Field | Description |
|-------|-------------|
| `elliptic.url` | Elliptic API base URL |
| `elliptic.key` | Real Elliptic API key |
| `elliptic.secret` | Real Elliptic HMAC secret (base64) |
| `elliptic.timeoutMs` | Timeout for upstream Elliptic requests (ms) |
| `rateLimitPerMinute` | Global per-partner rate limit |
| `maxBodyBytes` | Max request body size |
| `cacheTtlSeconds` | How often the proxy re-reads config from Secret Manager |
| `partners.<name>` | Partner HMAC secret (base64). The key is the partner name, sent in `x-access-key` |

## Authentication

Partners send three headers on every request:

- `x-access-key` — the partner name (matches a key in `config.partners`)
- `x-access-sign` — HMAC-SHA256 signature (base64)
- `x-access-timestamp` — millisecond timestamp

Partners sign requests using the same HMAC-SHA256 scheme Elliptic uses:

```
signature = HMAC-SHA256(
  base64_decode(partner_secret),
  timestamp + method + path + body
)
```

The proxy:
1. Looks up the partner's HMAC secret by name (`x-access-key` header value)
2. Recomputes the HMAC using the partner's secret and verifies it matches
   `x-access-sign`
3. Re-signs the request with the real Elliptic key and secret
4. Forwards with the new `x-access-key`, `x-access-sign`, `x-access-timestamp`

## Rate Limiting

- In-memory map: `partner → { count, windowStart }`.
- Per-partner limit from config, falling back to `defaults.rateLimitPerMinute`.
- Sliding window per minute.
- Resets on cold start — acceptable for a single-instance low-traffic service.

## Error Handling

| Condition | Response |
|-----------|----------|
| Missing/invalid `x-access-key` | `401 Unauthorized` |
| Bad HMAC signature | `401 Unauthorized` |
| Rate limit exceeded | `429 Too Many Requests` |
| Body exceeds `maxBodyBytes` | `413 Payload Too Large` |
| Config unavailable from Secret Manager | `503 Service Unavailable` |
| Elliptic network error | `503 Service Unavailable` |
| Elliptic non-2xx response | `502 Upstream Error` |

## Project Structure

```
elliptic-proxy/
├── design.md
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          # Cloud Function entry point
│   ├── config.ts         # Secret Manager config loading + caching
│   ├── auth.ts           # Partner lookup, HMAC verification
│   ├── elliptic.ts       # HMAC re-signing + forwarding to Elliptic
│   ├── rate-limit.ts     # In-memory per-partner rate limiter
│   ├── scoring.ts        # Rule-based response scoring (blocked/allowed)
│   └── cache.ts          # In-memory blocked address cache
```

## Deployment

```bash
gcloud functions deploy elliptic-proxy \
  --gen2 \
  --runtime=nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --min-instances=1 \
  --set-secrets='PROXY_CONFIG=elliptic-proxy-config:latest'
```
