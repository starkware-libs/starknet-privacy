# Elliptic Proxy — Design

## Overview

A GCP Cloud Function (TypeScript/Node.js) that screens blockchain addresses via
Elliptic's API. Third-party partners send an address; the proxy authenticates
the request, re-signs with real Elliptic credentials, forwards to Elliptic,
scores the response, and returns a `{ blocked: true/false }` verdict.

## Request Flow

```
Partner → Cloud Function → Elliptic API
         1. Extract x-access-key, x-access-sign, x-access-timestamp
         2. Look up partner by name (x-access-key = partner name)
         3. Verify partner's HMAC signature
         4. Check request body size limit
         5. Check rate limit
         6. Re-sign with real Elliptic key + secret
         7. Forward address to Elliptic for screening
         8. Score Elliptic response and return blocked/allowed verdict
```

## Configuration

A single JSON document stored in GCP Secret Manager
(`elliptic-proxy-config`). Updated via `gcloud secrets versions add` or GCP
Console — no redeploy needed. The proxy caches the config in memory and
re-reads it according to `configCacheTtlSeconds`.

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
  "configCacheTtlSeconds": 300,
  "blockedCacheTtlSeconds": 3600,
  "partners": {
    "partner-a": "issued-hmac-secret-base64",
    "partner-b": "issued-hmac-secret-base64"
  },
  "signingPrivateKey": "0x<stark-curve-private-key>",
  "chainId": "0x534e5f4d41494e",
  "additionalBlockedAddresses": [],
  "metricsAuthToken": "<bearer-token-for-GET-/metrics>"
}
```

### Configuration fields

| Field                                 | Description                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `elliptic.url`                        | Elliptic API base URL; `mock:` selects the in-process mock upstream (test deployments only)                                                                              |
| `elliptic.key`                        | Real Elliptic API key                                                                                                                                                    |
| `elliptic.secret`                     | Real Elliptic HMAC secret (base64)                                                                                                                                       |
| `elliptic.timeoutMs`                  | Timeout for upstream Elliptic requests (ms)                                                                                                                              |
| `rateLimitPerMinute`                  | Global per-partner rate limit                                                                                                                                            |
| `maxBodyBytes`                        | Max request body size                                                                                                                                                    |
| `configCacheTtlSeconds`               | How often the proxy re-reads config from Secret Manager (seconds)                                                                                                        |
| `blockedCacheTtlSeconds`              | How long to cache blocked address verdicts (seconds)                                                                                                                     |
| `partners.<name>`                     | Partner HMAC secret (base64). The key is the partner name, sent in `x-access-key`                                                                                        |
| `additionalBlockedAddresses` _(opt.)_ | Test-only deny list consumed by the mock upstream — listed addresses screen as sanctioned. Ignored when screening live (load-time warning).                              |
| `signingPrivateKey` _(required)_      | STARK-curve private key (felt hex) signing screening attestations; production key is FPI-managed.                                                                        |
| `chainId` _(required)_                | Hex felt of the network the deployment signs for, bound into the SNIP-12 domain. SN_MAIN + mock `elliptic.url` is rejected at config load.                               |
| `metricsAuthToken` _(opt.)_           | Bearer token gating `GET /metrics` (timing-safe compare). When unset, `/metrics` is disabled (`404`) — the exposition leaks partner names and traffic volumes, so it fails closed. |

### Verdict precedence

For each request the proxy evaluates sources in this order, first match wins:

1. blocked-address cache hit → `{ blocked: true, source: "cache" }`
2. Live (or mock) Elliptic call → `{ blocked, source: "elliptic" | "mock" }`

## Authentication

Partners send three headers on every request:

- `x-access-key` — the partner name (matches a key in `config.partners`)
- `x-access-sign` — HMAC-SHA256 signature (base64)
- `x-access-timestamp` — millisecond timestamp

Partners sign requests using the same HMAC-SHA256 scheme Elliptic uses:

```
signature = HMAC-SHA256(
  base64_decode(partner_secret),
  timestamp + method + lowercase(path) + body
)
```

The proxy:

1. Looks up the partner's HMAC secret by name (`x-access-key` header value)
2. Recomputes the HMAC using the partner's secret and verifies it matches
   `x-access-sign`
3. Re-signs the request with the real Elliptic key and secret
4. Forwards with the new `x-access-key`, `x-access-sign`, `x-access-timestamp`

## Rate Limiting

- In-memory per-partner state backed by an LRU cache: `partner → { count, windowStart }`.
- Fixed-window limiting using 1-minute buckets (not a sliding window).
- Per-partner limit from `config.rateLimitPerMinute`.
- The cache is capped at 20 partners; when full, least-recently-used entries are evicted.
- Evicted partners lose their current window state and start fresh on the next request.
- All counters reset on cold start — acceptable for a single-instance low-traffic service.

## Error Handling

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
│   ├── scoring.ts        # (planned) Rule-based response scoring (blocked/allowed)
│   ├── cache.ts          # (planned) In-memory blocked address cache
│   ├── mock-elliptic.ts  # In-process mock Elliptic upstream (mock: elliptic.url)
│   └── signing.ts        # Screening v2: STARK-curve attestation signer (/screen, on allow)
```

## Screening v2 — signing on `POST /screen`

Every allowed `/screen` verdict carries a STARK-curve ECDSA signature over a
SNIP-12 (revision 1) typed-data attestation binding `from_addr` and `issued_at`
(with the deployment's configured `chainId` in the domain) that the
privacy-pool contract verifies on-chain. Signing reuses partner auth and
rate-limiting; it fails closed (a sanctioned address is a `blocked:true`
verdict with no signature; a signing fault → 503). The message
and signature scheme is pinned by the canonical cross-language vectors in
`fixtures/screening-vectors.json` at the repo root.

## Mock Elliptic upstream

Setting `elliptic.url` to `mock:` screens against an in-process mock upstream
instead of elliptic.co — for test deployments only (elliptic.co has no coverage
outside mainnet). The full proxy pipeline (auth, scoring, caching, verdicts)
runs unchanged; only the upstream response is faked: addresses on
`additionalBlockedAddresses` score as sanctioned (and are cached like any live
block), everything else returns Elliptic's 404 "not in blockchain" and is
allowed. Mock verdicts report `source: "mock"` (cached repeats report
`cache`). A `mock_mode` warning is logged on every config load, and a mock url
combined with the SN_MAIN `chainId` is rejected at config load.

## Metrics & Alerting

`GET /metrics` serves a Prometheus text exposition, gated by a bearer token
(`Authorization: Bearer <metricsAuthToken>`; `404` when the token is unset).
FPI deploys the function and holds its logs, so this endpoint is how we observe
the proxy: point a Prometheus / GCP Managed Service for Prometheus scrape at the
function URL with the token. The endpoint bypasses the screening response path,
so scrapes never count toward the traffic metrics and a wrong scraper token
never trips the `401` alert.

| Metric                                    | Type    | Labels             | Meaning                                                                  |
| ----------------------------------------- | ------- | ------------------ | ------------------------------------------------------------------------ |
| `elliptic_proxy_elliptic_requests_total`  | counter | `partner`, `upstream` | Calls forwarded to the Elliptic upstream — the billed, allotment-capped resource. Counted at dispatch, so auth failures, rate-limits, operator-list hits, and blocked-cache hits are excluded. |
| `elliptic_proxy_http_responses_total`     | counter | `status`, `partner`   | Every response the proxy returns, by HTTP status. `partner` is a known partner or `"unknown"`. |
| `process_*`                               | various | —                  | prom-client default metrics; `process_start_time_seconds` reveals cold-start counter resets. |

**Single-instance assumption.** Counters are per-instance in-memory state, like
the rate-limiter and blocked-address cache. They are coherent under the
recommended `--max-instances=1`; multiple instances would each keep independent
counters that the function URL load-balances across opaquely.

### Alert rules

```promql
# Elliptic abuse by partner — names whose partner secret to revoke under a DDoS
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

Pick `<rate>`/`<budget>` thresholds from observed baseline traffic and the
Elliptic allotment. Cross-check the absolute-usage alert against
`changes(process_start_time_seconds[1h])` to spot a restart that zeroed the
counters.

## Deployment

```bash
gcloud functions deploy elliptic-proxy \
  --gen2 \
  --runtime=nodejs22 \
  --trigger-http \
  --allow-unauthenticated \
  --min-instances=1 \
  --max-instances=1 \
  --set-env-vars='PROXY_CONFIG=projects/$GOOGLE_CLOUD_PROJECT/secrets/elliptic-proxy-config/versions/latest'
```
