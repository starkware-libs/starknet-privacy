# Elliptic Proxy

A GCP Cloud Function that proxies requests to the [Elliptic API](https://www.elliptic.co/), swapping each partner's HMAC auth for that partner's own Elliptic credentials. Partners authenticate with their own HMAC keys; the proxy verifies, rate-limits, re-signs with the partner's Elliptic key + secret, forwards to Elliptic, and scores the response to return a blocked/allowed verdict.

## Request flow

```
Partner → Cloud Function → Elliptic API
            │
            ├─ Verify partner HMAC signature
            ├─ Check body size
            ├─ Rate limit (per-partner, per-minute)
            ├─ Re-sign with the partner's own Elliptic credentials
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
    "timeoutMs": 10000
  },
  "rateLimitPerMinute": 100,
  "maxBodyBytes": 10240,
  "configCacheTtlSeconds": 300,
  "blockedCacheTtlSeconds": 3600,
  "partners": {
    "partner-name": {
      "hmacSecret": "<base64-encoded-partner-secret>",
      "ellipticKey": "<partner-elliptic-api-key>",
      "ellipticSecret": "<base64-encoded-elliptic-secret>"
    }
  },
  "signingPrivateKey": "0x<stark-curve-private-key>",
  "chainId": "0x534e5f4d41494e",
  "additionalBlockedAddresses": [],
  "blockOverrideAddresses": [],
  "allowByok": false
}
```

| Field                                     | Description                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `elliptic.url`                            | Elliptic AML API base URL. Use `https://aml-api.elliptic.co` (note `aml-api`, **not** `api`). `mock:` selects the in-process mock upstream (test deployments only).                                                                                                                                                                              |
| `elliptic.timeoutMs`                      | Timeout for upstream Elliptic requests (ms)                                                                                                                                                                                                                                                                                                      |
| `rateLimitPerMinute`                      | Per-partner rate limit (requests per minute)                                                                                                                                                                                                                                                                                                     |
| `maxBodyBytes`                            | Max request body size                                                                                                                                                                                                                                                                                                                            |
| `configCacheTtlSeconds`                   | How long to cache the config before re-reading from Secret Manager (seconds)                                                                                                                                                                                                                                                                     |
| `blockedCacheTtlSeconds`                  | How long to cache blocked address verdicts (seconds)                                                                                                                                                                                                                                                                                             |
| `partners.<name>`                         | Per-partner credentials, keyed by the partner name (sent in `x-access-key`). Object with `hmacSecret` (base64) verifying the inbound HMAC, plus `ellipticKey` and `ellipticSecret` (base64) — the partner's own Elliptic credentials used to re-sign that partner's upstream calls. **Caution** on `ellipticSecret`: a base64 secret can look identical to hex — any 32-char `[0-9a-f]` string is valid in both. Paste Elliptic's value as-is; don't run it through `xxd -r -p \| base64` just because it "looks like hex".                                                                                                                                                                                                                                                        |
| `additionalBlockedAddresses` _(optional)_ | Operator deny list (hex felts): listed addresses always screen as blocked, in every mode, regardless of the upstream verdict — covers sanctioned addresses the upstream misses (false negatives). Entries match on the canonical felt value, so zero-padded entries match stripped addresses.                                                    |
| `blockOverrideAddresses` _(optional)_     | Operator allow list (hex felts): listed addresses always screen as allowed, winning over the deny list, the blocked cache, and the upstream verdict — rescues addresses the upstream wrongly flags (false positives).                                                                                                                            |
| `signingPrivateKey` _(required)_          | STARK-curve private key (felt hex, `1 <= key < curve order`) signing screening attestations; the production key is FPI-managed.                                                                                                                                                                                                                  |
| `chainId` _(required)_                    | Hex felt of the network the deployment signs for, bound into the SNIP-12 domain. SN_MAIN combined with a mock `elliptic.url` is rejected at config load.                                                                                                                                                                                         |
| `allowByok` _(optional)_                  | Enables the [BYOK](#byok-bring-your-own-key) path when set to the literal `true`; absent or any other value is `false`. Off by default — enabling it is a security decision (BYOK verdicts are signed with this deployment's key).                                                                                                                |

### Generating partner secrets

```bash
# Generate a random 32-byte secret, base64-encoded
openssl rand -base64 32
```

Share the raw secret with the partner. Store the base64-encoded value as that partner's `hmacSecret` in the config. The partner's `ellipticKey`/`ellipticSecret` are issued by Elliptic, not generated here.

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

## BYOK (bring-your-own-key)

When `allowByok` is enabled, a client that is **not** a registered partner can
screen by supplying its own Elliptic credentials. Instead of `x-access-key`, send:

| Header               | Value                                                            |
| -------------------- | ---------------------------------------------------------------- |
| `x-elliptic-key`     | The client's own Elliptic API key                                |
| `x-elliptic-secret`  | The client's own Elliptic HMAC secret (base64)                   |
| `x-access-sign`      | `HMAC-SHA256(x-elliptic-secret, ts + method + lowercase(path) + body)` |
| `x-access-timestamp` | Unix timestamp in milliseconds                                   |

The client self-signs with its own Elliptic secret (proving possession + body
integrity, replay-bounded by the 5-minute window); the proxy forwards using the
client's key + secret. Credentials are sent in headers only and never logged.
Verdicts report `source: "byok"` and are rate-limited under a synthetic
`byok:<hash>` id. A registered partner always takes the partner path.

> **⚠️ Security:** a BYOK allowed verdict is signed with this deployment's
> `signingPrivateKey`, and the on-chain verifier cannot distinguish it from a
> vetted partner's attestation (the verdict `source` is not in the signed
> struct). Enabling BYOK lets anyone with any Elliptic key obtain a pool-trusted
> attestation. Enable deliberately; keep `allowByok` off unless that trade-off is
> intended, and never reuse a mainnet-trusted signing key on a testnet/mock
> deployment.

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
