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
  "signingPrivateKey": "0x<stark-curve-private-key>",
  "chainId": "0x534e5f4d41494e",
  "additionalBlockedAddresses": [],
  "blockOverrideAddresses": [],
  "metricsAuthToken": "<bearer-token-for-GET-/metrics>"
}
```

| Field                                     | Description                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `elliptic.url`                            | Elliptic AML API base URL. Use `https://aml-api.elliptic.co` (note `aml-api`, **not** `api`). `mock:` selects the in-process mock upstream (test deployments only).                                                                                                                                                                              |
| `elliptic.key`                            | Real Elliptic API key                                                                                                                                                                                                                                                                                                                            |
| `elliptic.secret`                         | Real Elliptic HMAC secret. Paste the value Elliptic provides exactly as-is. **Caution**: a base64 secret can look identical to hex — any 32-character string drawn entirely from `[0-9a-f]` is valid in both alphabets. Don't run a value through `xxd -r -p \| base64` just because it "looks like hex" — trust Elliptic's label, not the string's appearance. |
| `elliptic.timeoutMs`                      | Timeout for upstream Elliptic requests (ms)                                                                                                                                                                                                                                                                                                      |
| `rateLimitPerMinute`                      | Per-partner rate limit (requests per minute)                                                                                                                                                                                                                                                                                                     |
| `maxBodyBytes`                            | Max request body size                                                                                                                                                                                                                                                                                                                            |
| `configCacheTtlSeconds`                   | How long to cache the config before re-reading from Secret Manager (seconds)                                                                                                                                                                                                                                                                     |
| `blockedCacheTtlSeconds`                  | How long to cache blocked address verdicts (seconds)                                                                                                                                                                                                                                                                                             |
| `partners.<name>`                         | Partner HMAC secret (base64-encoded). The key is the partner name, sent in `x-access-key`                                                                                                                                                                                                                                                        |
| `additionalBlockedAddresses` _(optional)_ | Operator deny list (hex felts): listed addresses always screen as blocked, in every mode, regardless of the upstream verdict — covers sanctioned addresses the upstream misses (false negatives). Entries match on the canonical felt value, so zero-padded entries match stripped addresses.                                                    |
| `blockOverrideAddresses` _(optional)_     | Operator allow list (hex felts): listed addresses always screen as allowed, winning over the deny list, the blocked cache, and the upstream verdict — rescues addresses the upstream wrongly flags (false positives).                                                                                                                            |
| `signingPrivateKey` _(required)_          | STARK-curve private key (felt hex, `1 <= key < curve order`) signing screening attestations; the production key is FPI-managed.                                                                                                                                                                                                                  |
| `chainId` _(required)_                    | Hex felt of the network the deployment signs for, bound into the SNIP-12 domain. SN_MAIN combined with a mock `elliptic.url` is rejected at config load.                                                                                                                                                                                         |
| `metricsAuthToken` _(optional)_           | Bearer token gating `GET /metrics` (timing-safe compare). When unset, `/metrics` is disabled (`404`); the exposition leaks partner names and traffic volumes, so it fails closed. See [Metrics & alerting](#metrics--alerting).                                                                                                                   |

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
| `allowlist` | Operator allow override (`blockOverrideAddresses`) — always allowed, wins over everything below.                                        |
| `blocklist` | Operator deny list (`additionalBlockedAddresses`) — always blocked, wins over the cache and the upstream.                               |
| `elliptic`  | Verdict scored from a live Elliptic call.                                                                                               |
| `cache`     | Verdict served from the local blocked-address cache (skips the Elliptic call for known-blocked addresses).                              |
| `mock`      | Verdict produced by the in-process mock upstream (`mock:` elliptic.url).                                                                |

Precedence (first match wins): `allowlist` → `blocklist` → `cache` → `elliptic` (`mock` when the mock upstream is selected).

Errors (HTTP 4xx/5xx) return `{ "error": "<reason>" }` with no `source` field.

## Screening v2 — signing on `POST /screen`

Every **allowed** `POST /screen` response carries a STARK-curve signature the
privacy-pool contract verifies on-chain — the response is the attestation. The
signature is bound to the deployment's configured `chainId`; the caller
sends only the address:

```json
{ "address": "0x049d…" }
```

The signed message is a SNIP-12 (revision 1) typed-data attestation binding the
deposit's `from_addr` and `issued_at`, with the configured chain id in the
domain. The exact
construction and golden values are the canonical cross-language vectors in
`fixtures/screening-vectors.json` at the repo root (regenerate with
`scripts/gen_screening_fixtures.py`, which signs with the reference signer in
`scripts/address_validation_signer/py`).

| Status | Body                                                                                                    | Meaning                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `200`  | `{ "blocked": false, "source": …, "signature": { "issued_at": 171…, "sig_r": "0x…", "sig_s": "0x…" } }` | Allowed and signed — every allow carries a signature.                                  |
| `200`  | `{ "blocked": true, "source": … }`                                                                      | Sanctioned (terminal). `source` is the blocking path (`elliptic` / `mock` / `cache`). No signature on any block. |
| `400`  | `{ "error": "missing address" \| "invalid address format" \| "invalid address" }`                       | Malformed request (incl. address ≥ 2\*\*251).                                          |
| `401`  | `{ "error": "…" }`                                                                                      | Partner auth failed.                                                                   |
| `503`  | `{ "error": "signing failed" }`                                                                         | The signer faulted — fail closed (no unsigned allow).                                  |

> Signatures are never cached: only blocked verdicts are cached and a block
> never carries a signature, so every signed allow is produced fresh.

## Mock Elliptic upstream

Setting `elliptic.url` to `mock:` screens against an in-process mock upstream
instead of elliptic.co — for test deployments only (elliptic.co has no coverage
outside mainnet). The full proxy pipeline (auth, operator lists, scoring,
caching, verdicts) runs unchanged; only the upstream response is faked: the
mock answers every address with Elliptic's 404 "not in blockchain", which is
allowed and reports `source: "mock"`. Deterministic blocks on a mock
deployment come from `additionalBlockedAddresses`, which applies in every mode
(`source: "blocklist"`). A `mock_mode` warning is logged on every config load,
and a mock url combined with the SN_MAIN `chainId` is rejected at config load.

## Rate limiting

- In-memory per-partner state backed by an LRU cache: `partner → { count, windowStart }`.
- Fixed-window limiting using 1-minute buckets (not a sliding window).
- Per-partner limit from `config.rateLimitPerMinute`.
- The cache is capped at 20 partners; when full, least-recently-used entries are evicted.
- Evicted partners lose their current window state and start fresh on the next request.
- All counters reset on cold start — acceptable for a single-instance low-traffic service.

## Error handling

| Condition                              | Response                  |
| -------------------------------------- | ------------------------- |
| Missing/invalid `x-access-key`         | `401 Unauthorized`        |
| Bad HMAC signature                     | `401 Unauthorized`        |
| Rate limit exceeded                    | `429 Too Many Requests`   |
| Body exceeds `maxBodyBytes`            | `413 Payload Too Large`   |
| Config unavailable from Secret Manager | `503 Service Unavailable` |
| Elliptic network error / timeout       | `504 Gateway Timeout`     |
| Elliptic 404 (subject not on chain)    | `200 { blocked: false }`  |
| Elliptic other non-2xx response        | `502 Upstream Error`      |

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
| `source`            | Which path produced the verdict: `allowlist`, `blocklist`, `elliptic`, `mock`, or `cache`. Absent on error responses.                                                     |
| `signed`            | `true` on an allowed (signed) response. Absent on blocks and errors.                                                                                             |
| `reason`            | Rejection reason (`missing_headers`, `timestamp_expired`, `unknown_partner`, `invalid_signature`, `rate_limited`, `upstream_request_failed`, `upstream_non_2xx`) |
| `errorType`         | On an error result: `network`, `upstream_non_2xx`, `malformed_json`, or `signing` (a `signScreening` fault on the signing path).                                 |
| `ellipticStatus`    | Upstream Elliptic response status (on success)                                                                                                                   |
| `ellipticLatencyMs` | Upstream Elliptic response latency (on success, source=elliptic)                                                                                                 |

Errors are logged to stderr:

- `error: "config_load_failed"` — Secret Manager fetch / parse failure.
- `error: "upstream_request_failed"` — fetch to Elliptic threw at the transport layer (DNS, TLS, TCP, timeout). Includes `cause.code` (e.g. `ENOTFOUND`, `ECONNREFUSED`) so the underlying reason is visible without code changes.
- `error: "upstream_error"` — Elliptic returned a non-2xx response. Includes `ellipticStatus` and the first 2KB of the response body, so HTTP-level errors (`401 AuthenticationError`, `400 ValidationError`, etc.) are diagnosable from logs alone.
- `error: "unhandled_exception"` — a bug escaped the handler; the proxy fails closed with a `500`. Surfaced as a metric too (see below), since FPI holds the logs.

## Metrics & alerting

`GET /metrics` serves a Prometheus exposition gated by a bearer token
(`Authorization: Bearer <metricsAuthToken>`; `404` when the token is unset).
FPI deploys the function and holds its logs, so this endpoint is how we observe
the proxy — point a Prometheus / GCP Managed Service for Prometheus scrape at
the function URL with the token. Scrapes bypass the screening response path, so
they never count toward the traffic metrics.

| Metric                                   | Type    | Labels                | Meaning                                                                                                        |
| ---------------------------------------- | ------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `elliptic_proxy_elliptic_requests_total` | counter | `partner`, `upstream` | Calls forwarded to the Elliptic upstream — the billed resource. Counted at dispatch, so short-circuited requests (auth failure, rate-limit, operator lists, blocked cache) are excluded. |
| `elliptic_proxy_http_responses_total`    | counter | `status`, `partner`   | Every response by HTTP status. `partner` is a known partner or `"unknown"` (the `x-access-key` header is untrusted). |
| `process_*`                              | various | —                     | prom-client defaults; `process_start_time_seconds` reveals a cold-start counter reset.                          |

Counters are per-instance in-memory state (like the rate-limiter and blocked
cache); they are coherent under the recommended `--max-instances=1`.

```promql
# Elliptic abuse by partner — names whose secret to revoke under a DDoS
sum by (partner) (rate(elliptic_proxy_elliptic_requests_total{upstream="elliptic"}[5m])) > <rate>

# Absolute Elliptic usage over the budget window — increase() tolerates resets
sum(increase(elliptic_proxy_elliptic_requests_total{upstream="elliptic"}[30d])) > <budget>

# Our bug — alert on a single 500/503
sum(increase(elliptic_proxy_http_responses_total{status=~"500|503"}[10m])) > 0

# Elliptic upstream down — high rate of 502/504
sum(rate(elliptic_proxy_http_responses_total{status=~"502|504"}[5m])) > <rate>

# Partner-secret problem — high rate of 401, by partner
sum by (partner) (rate(elliptic_proxy_http_responses_total{status="401"}[5m])) > <rate>
```
