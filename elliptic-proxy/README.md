# Elliptic Proxy

A GCP Cloud Function that proxies requests to the [Elliptic API](https://www.elliptic.co/), swapping partner credentials for real Elliptic credentials. Partners authenticate with their own HMAC keys; the proxy verifies, rate-limits, re-signs, forwards to Elliptic, and scores the response to return a blocked/allowed verdict.

## Request flow

```
Partner → Cloud Function → Elliptic API
            │
            ├─ Verify partner HMAC signature
            ├─ Check body size
            ├─ Rate limit (per-partner, per-minute)
            ├─ Re-sign with real Elliptic credentials
            ├─ Forward to Elliptic
            └─ Score response → { blocked: true/false }
```

## Configuration

The proxy reads its configuration from **GCP Secret Manager**. The secret resource name is specified via the `PROXY_CONFIG` environment variable.

### Config schema

The secret value must be a JSON string with this structure:

```json
{
  "elliptic": {
    "url": "https://api.elliptic.co",
    "key": "your-elliptic-api-key",
    "secret": "<base64-encoded-elliptic-secret>",
    "timeoutMs": 10000
  },
  "rateLimitPerMinute": 100,
  "maxBodyBytes": 10240,
  "configCacheTtlSeconds": 300,
  "blockedCacheTtlSeconds": 3600,
  "partners": {
    "partner-name": "<base64-encoded-partner-secret>"
  }
}
```

| Field | Description |
|-------|-------------|
| `elliptic.url` | Elliptic API base URL |
| `elliptic.key` | Real Elliptic API key |
| `elliptic.secret` | Real Elliptic HMAC secret (base64-encoded) |
| `elliptic.timeoutMs` | Timeout for upstream Elliptic requests (ms) |
| `rateLimitPerMinute` | Per-partner rate limit (requests per minute) |
| `maxBodyBytes` | Max request body size |
| `configCacheTtlSeconds` | How long to cache the config before re-reading from Secret Manager (seconds) |
| `blockedCacheTtlSeconds` | How long to cache blocked address verdicts (seconds) |
| `partners.<name>` | Partner HMAC secret (base64-encoded). The key is the partner name, sent in `x-access-key` |

### Generating partner secrets

```bash
# Generate a random 32-byte secret, base64-encoded
openssl rand -base64 32
```

Share the raw secret with the partner. Store the base64-encoded value in the config.

## Partner authentication

Partners sign requests using HMAC-SHA256, identical to the [Elliptic API signature scheme](https://docs.elliptic.co/):

```
HMAC-SHA256(secret, timestamp + method + path + body)
```

Required headers on every request:

| Header | Value |
|--------|-------|
| `x-access-key` | Partner name (matches a key in `config.partners`) |
| `x-access-sign` | Base64-encoded HMAC-SHA256 signature |
| `x-access-timestamp` | Unix timestamp in milliseconds |

## Deployment

### Prerequisites

- GCP project with Cloud Functions and Secret Manager APIs enabled
- `gcloud` CLI authenticated

### Create the secret

```bash
echo '{"elliptic": {...}, "partners": {...}}' | \
  gcloud secrets create elliptic-proxy-config --data-file=-
```

### Deploy

```bash
cd elliptic-proxy
npm run build

gcloud functions deploy elliptic-proxy \
  --gen2 \
  --runtime=nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point=ellipticProxy \
  --set-env-vars=PROXY_CONFIG=projects/<PROJECT_ID>/secrets/elliptic-proxy-config/versions/latest \
  --source=.
```

### Updating config

Update the secret value in Secret Manager. The proxy will pick up the new config after `configCacheTtlSeconds` expires (no redeploy needed).

```bash
echo '{"elliptic": {...}}' | \
  gcloud secrets versions add elliptic-proxy-config --data-file=-
```

## Local development

```bash
cd elliptic-proxy
npm install
npm run dev          # watch mode TypeScript compilation

# In another terminal — requires PROXY_CONFIG env var
PROXY_CONFIG=projects/<PROJECT_ID>/secrets/elliptic-proxy-config/versions/latest \
  npm start
```

## Testing

```bash
npm test             # run all tests
npm run test:watch   # watch mode
```

## Logging

All requests are logged as structured JSON to stdout (picked up by Cloud Logging automatically). Each log line includes:

| Field | Description |
|-------|-------------|
| `method` | HTTP method |
| `path` | Request path |
| `status` | Response status code |
| `latencyMs` | Total request duration |
| `partner` | Partner name (if identified) |
| `reason` | Rejection reason (`missing_headers`, `unknown_partner`, `invalid_signature`, `rate_limited`) |
| `ellipticStatus` | Upstream Elliptic response status (on success) |

Config load failures are logged to stderr with `error: "config_load_failed"`.
