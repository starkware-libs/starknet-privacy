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
    "url": "https://aml-api.elliptic.co",
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
  },
  "skipElliptic": false,
  "additionalBlockedAddresses": [],
  "blockOverrideAddresses": []
}
```

| Field                                     | Description                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `elliptic.url`                            | Elliptic AML API base URL. Use `https://aml-api.elliptic.co` (note `aml-api`, **not** `api`).                                                                                                                                                                                                                                                    |
| `elliptic.key`                            | Real Elliptic API key                                                                                                                                                                                                                                                                                                                            |
| `elliptic.secret`                         | Real Elliptic HMAC secret. Paste the value Elliptic provides exactly as-is. **Caution**: a base64 secret can look identical to hex (e.g. `2586b6295906e305ba2a37db56b03aaa` is valid in both alphabets). Don't run a value through `xxd -r -p \| base64` just because it "looks like hex" — trust Elliptic's label, not the string's appearance. |
| `elliptic.timeoutMs`                      | Timeout for upstream Elliptic requests (ms)                                                                                                                                                                                                                                                                                                      |
| `rateLimitPerMinute`                      | Per-partner rate limit (requests per minute)                                                                                                                                                                                                                                                                                                     |
| `maxBodyBytes`                            | Max request body size                                                                                                                                                                                                                                                                                                                            |
| `configCacheTtlSeconds`                   | How long to cache the config before re-reading from Secret Manager (seconds)                                                                                                                                                                                                                                                                     |
| `blockedCacheTtlSeconds`                  | How long to cache blocked address verdicts (seconds)                                                                                                                                                                                                                                                                                             |
| `partners.<name>`                         | Partner HMAC secret (base64-encoded). The key is the partner name, sent in `x-access-key`                                                                                                                                                                                                                                                        |
| `skipElliptic` _(optional)_               | When `true`, the proxy never calls Elliptic. Intended for non-mainnet deployments where Elliptic has no data coverage (Elliptic does not index testnets, and at the time of writing has no Starknet coverage at all), or as a kill switch on mainnet. Operator-policy lists below still apply. Defaults to `false`.                              |
| `additionalBlockedAddresses` _(optional)_ | Lowercase hex addresses to always treat as blocked, regardless of Elliptic's verdict (or in lieu of it when `skipElliptic` is set). Operator-curated supplemental deny list — surfaces as `{blocked: true, source: "blocklist"}`.                                                                                                                |
| `blockOverrideAddresses` _(optional)_     | Lowercase hex addresses to always treat as allowed. Wins over both `additionalBlockedAddresses` and Elliptic — use to rescue addresses we believe were wrongly flagged. Surfaces as `{blocked: false, source: "allowlist"}`.                                                                                                                     |

### Generating partner secrets

```bash
# Generate a random 32-byte secret, base64-encoded
openssl rand -base64 32
```

Share the raw secret with the partner. Store the base64-encoded value in the config.

## Partner authentication

Partners sign requests using HMAC-SHA256, identical to the [Elliptic API signature scheme](https://docs.elliptic.co/):

```
HMAC-SHA256(secret, timestamp + method + lowercase(path) + body)
```

Note: the request path is lowercased before signing, matching the Elliptic API convention.

Required headers on every request:

| Header               | Value                                             |
| -------------------- | ------------------------------------------------- |
| `x-access-key`       | Partner name (matches a key in `config.partners`) |
| `x-access-sign`      | Base64-encoded HMAC-SHA256 signature              |
| `x-access-timestamp` | Unix timestamp in milliseconds                    |

## Response shape

Successful responses (HTTP 200) include a `blocked` boolean and a `source`
field that names which code path produced the verdict:

```json
{ "blocked": false, "source": "elliptic" }
```

| `source`    | Meaning                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `elliptic`  | Verdict scored from a live Elliptic call.                                                                                               |
| `cache`     | Verdict served from the local blocked-address cache (skips the Elliptic call for known-blocked addresses).                              |
| `allowlist` | Operator override matched: address is in `blockOverrideAddresses`. Always `blocked: false`. Wins over every other source.               |
| `blocklist` | Operator deny supplement matched: address is in `additionalBlockedAddresses`. Always `blocked: true`. Wins over Elliptic and the cache. |
| `skip`      | Elliptic was not called (`skipElliptic` is set) and no operator list matched. Always `blocked: false`.                                  |

Precedence (first match wins): `allowlist` → `blocklist` → `skip` → `cache` → `elliptic`.

Errors (HTTP 4xx/5xx) return `{ "error": "<reason>" }` with no `source` field.

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
  --runtime=nodejs22 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point=ellipticProxy \
  --set-env-vars=PROXY_CONFIG=projects/<PROJECT_ID>/secrets/elliptic-proxy-config/versions/latest \
  --source=.
```

The `gcp-build` npm script runs `tsc` automatically during the Cloud
Buildpacks build, so the source-only deploy above is sufficient. Don't
add `dist/` to `.gcloudignore`; the buildpack will (re)compile it from
`src/` on every deploy.

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

| Field               | Description                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`            | HTTP method                                                                                                                                                      |
| `path`              | Request path                                                                                                                                                     |
| `status`            | Response status code                                                                                                                                             |
| `latencyMs`         | Total request duration                                                                                                                                           |
| `partner`           | Partner name (if identified)                                                                                                                                     |
| `result`            | `allowed` / `blocked` / `cached` / `error`                                                                                                                       |
| `source`            | Which path produced the verdict: `elliptic`, `cache`, `allowlist`, `blocklist`, or `skip`. Absent on error responses.                                            |
| `reason`            | Rejection reason (`missing_headers`, `timestamp_expired`, `unknown_partner`, `invalid_signature`, `rate_limited`, `upstream_request_failed`, `upstream_non_2xx`) |
| `ellipticStatus`    | Upstream Elliptic response status (on success)                                                                                                                   |
| `ellipticLatencyMs` | Upstream Elliptic response latency (on success, source=elliptic)                                                                                                 |

Errors are logged to stderr:

- `error: "config_load_failed"` — Secret Manager fetch / parse failure.
- `error: "upstream_request_failed"` — fetch to Elliptic threw at the transport layer (DNS, TLS, TCP, timeout). Includes `cause.code` (e.g. `ENOTFOUND`, `ECONNREFUSED`) so the underlying reason is visible without code changes.
- `error: "upstream_error"` — Elliptic returned a non-2xx response. Includes `ellipticStatus` and the first 2KB of the response body, so HTTP-level errors (`401 AuthenticationError`, `400 ValidationError`, etc.) are diagnosable from logs alone.
