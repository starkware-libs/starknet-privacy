# proof-interceptor

JSON-RPC service that screens privacy-pool deposit transactions against OFAC sanctions before the transaction prover produces a proof. It sits alongside the prover as an in-pod sidecar and is called by the prover, not by end clients.

The prover stays the public entry point of the system; client APIs do not change. Screening is invisible from the outside — when a transaction is allowed the client gets a proof as usual, when it is blocked the client gets JSON-RPC error code `10000` ("Transaction rejected").

> **Production policy at a glance:** fail-closed at both layers (defaults), `SCREENING_BLOCK_NON_POOL_TX=true`, listener binding chosen deliberately (prefer `HOST=127.0.0.1` unless direct Prometheus scraping requires `HOST=0.0.0.0` plus a NetworkPolicy restricting ingress to the prover and the approved scraper), `SCREENING_URL` set, SDK pinned to match the deployed pool contract. The shipped defaults are biased toward "don't break unrelated transaction flows" rather than "be a strict compliance gate"; production must opt into the strict path.

## Where it fits

<div align="center">

```mermaid
flowchart LR
    Client(["Client"])
    Prover["Transaction prover"]
    EP["elliptic-proxy<br/>(Cloud Function)"]
    Elliptic[("Elliptic AML API")]

    subgraph Sidecar ["proof-interceptor sidecar (this service)"]
        direction TB
        RPC["starknet_checkTransaction handler"]
        Gate["Pool-call gate"]
        Detect["Deposit detection"]
        Screen["Per-address screen + retry"]
        RPC --> Gate --> Detect --> Screen
    end

    Client -- "starknet_<br/>proveTransaction" --> Prover
    Prover -- "starknet_checkTransaction<br/>(localhost:8080)" --> RPC
    Screen -- "POST /screen<br/>HMAC-signed" --> EP
    EP --> Elliptic
```

</div>

The prover runs the screening round-trip in parallel with proving. The sidecar receives one `starknet_checkTransaction` per client `starknet_proveTransaction`, decodes the deposit action span using `PrivacyPoolABI` from `@starkware-libs/starknet-privacy-sdk`, and screens `user_addr` via HMAC-signed `POST /screen` to elliptic-proxy. That single `/screen` call screens **and**, on allow, returns a STARK-curve signature over the depositor address; the sidecar relays that signature on the `checkTransaction` allow response, and the prover attaches it under `additional_data.signature` for the SDK to pack into the deposit's `apply_actions` calldata. This service is stateless. The HMAC scheme (SHA-256 over `timestamp || method || path.toLowerCase() || body`, base64-decoded partner secret as the key) lives in `src/screening-interceptor.ts:computeHmacSignature` — use that as the reference if you need to verify partner credentials independently.

## What gets screened

| Category                      | Verdict                                             | When                                                                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Screened**                  | depends on Elliptic                                 | Single direct INVOKE-v3 to `SCREENING_POOL_ADDRESS` that puts up an address: a Deposit's depositor (`user_addr`), the shadow account an interaction runs through, or an invoke target whose open-note policy is `Required`.                                                                                                    |
| **Bypass (non-pool)**         | `allow`                                             | Multi-call INVOKEs and calls to contracts other than `SCREENING_POOL_ADDRESS`. Set `SCREENING_BLOCK_NON_POOL_TX=true` to block these instead. Non-canonical felt encodings (`"0x01"`, `"0X1"`, a case-mismatched address) are *not* in this category: `normalizeFelt` folds case, the `0X` prefix and leading zeros, so such a pool call is screened like any other. |
| **Bypass (pool, no Deposit)** | `allow`                                             | Pool calls with no Deposit action (withdraw-only) or whose action span fails to decode (most often ABI drift). **Not affected by `SCREENING_BLOCK_NON_POOL_TX`** — this toggle only changes the non-pool branch.                                                      |
| **Blocked**                   | RPC error `10000`                                   | Sanctioned `user_addr`, screening-pipeline failure with fail-closed defaults, or any unhandled exception inside an interceptor (caught and converted to a block whose reason is the opaque `interceptor_error`; the exception's message is logged, not returned).                                                            |
| **Inconclusive**              | RPC error other than `10000`, or no response at all | Envelope rejection (e.g. RPC error `61` "Unsupported tx version"), network error talking to the sidecar, timeout, or any non-`10000` RPC error. The prover decides what to do via its `blocking_check_fail_open` setting.                                             |

## Production safety checklist

Defaults are deployment-friendly, not security-strict. Apply these for production:

- **`SCREENING_BLOCK_NON_POOL_TX=true`** — converts the multi-call bypass and the non-canonical-felt bypass into blocks. The single most important toggle.
- **`SCREENING_FAIL_OPEN=false`** here, and **set prover-side `blocking_check_fail_open=false` explicitly** — the prover defaults it to `true`, so an inconclusive check proves the transaction unscreened unless the deployment overrides it.
- **Choose listener binding deliberately.** The service has no application-level authentication, so the host binding is the security boundary. Prefer `HOST=127.0.0.1` (loopback-only, in-pod sidecar) when metrics can be relayed by the prover or a co-located collector. Use `HOST=0.0.0.0` only when direct Prometheus scraping of the Pod IP is required, and pair it with a NetworkPolicy restricting ingress to the prover and the approved scraper. Co-location in the same Pod is _not_ by itself the boundary: with `HOST=0.0.0.0`, the listener is reachable from any Pod that can route to this Pod's IP.
- **`TLS_CERT_PATH`/`TLS_KEY_PATH` are server-side TLS only.** They encrypt the prover↔sidecar connection but do _not_ authenticate the client (no `requestCert`/`ca` is configured in `src/server.ts`). For real mTLS, put a service mesh or proxy in front of the sidecar.
- **Verify `SCREENING_URL` is set.** Without it, the service runs as a no-op pass-through that always returns `allowed: true` — `/health` still reports OK. Confirm `proof_interceptor_screening_results_total` is non-zero on `/metrics`.
- **Point `SCREENING_RPC_URL` at an endpoint serving JSON-RPC spec ≥ 0.9.** The pre-policy-pool fallback keys on the dedicated entrypoint-miss error (21); an older endpoint reports a generic contract error instead, so every policy read fails closed and open-note deposits block.
- **Pin `@starkware-libs/starknet-privacy-sdk`** to a version whose `PrivacyPoolABI` matches the deployed pool contract. ABI drift causes silent fail-open on Deposit detection.

## Configuration

Required when screening is enabled (the production case):

| Env var                    | Purpose                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCREENING_URL`            | Base URL of the elliptic-proxy. Setting this is what enables screening — leaving it unset is the silent-pass-through hazard.                            |
| `SCREENING_PARTNER_NAME`   | Partner identifier issued by the proxy operator.                                                                                                        |
| `SCREENING_PARTNER_SECRET` | Base64-encoded HMAC key issued by the proxy operator.                                                                                                   |
| `SCREENING_POOL_ADDRESS`   | Privacy-pool contract address — only direct calls to this address are screened.                                                                         |
| `SCREENING_RPC_URL`        | Starknet JSON-RPC endpoint, used to read the pool's open-note screening policies. A pool without the policy entrypoint predates the list and enforces its own block list on chain, so every read answers `Exempt` and this service can deploy before the pool upgrades. A `Delegated` depositor is taken to be a shadow account anonymizer, and its interactions are screened on the shadow account they run through, derived locally. |

Plus the production toggle `SCREENING_BLOCK_NON_POOL_TX=true` discussed above. Optional knobs (`SCREENING_TIMEOUT_MS`, `SCREENING_TOTAL_TIMEOUT_MS`, `SCREENING_MAX_RETRIES`, `SCREENING_FAIL_OPEN`, `SCREENING_POLICY_TTL_MS`, `SCREENING_POLICY_TIMEOUT_MS`, `PORT`, `HOST`, `MAX_BODY_BYTES`, `TLS_CERT_PATH`/`TLS_KEY_PATH`) and their defaults are in `src/config.ts`. Note: `SCREENING_FAIL_OPEN` does **not** apply to the screening-v2 signing path — a deposit without a signature cannot proceed on-chain, so a signing failure always fails closed.

## HTTP endpoints

| Path       | Method | Description                                                                                                           |
| ---------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `/`        | POST   | JSON-RPC entrypoint. Only `starknet_checkTransaction` is accepted; everything else returns `-32601 Method not found`. |
| `/health`  | GET    | Liveness/readiness. Returns `200 {"status":"ok"}`.                                                                    |
| `/metrics` | GET    | Prometheus metrics.                                                                                                   |

### Request

The body mirrors `starknet_proveTransaction` exactly (object or positional params). The screened shape is a single direct INVOKE-v3 to `SCREENING_POOL_ADDRESS` with `calldata = [call_count=1, contract_address=pool, selector, inner_len, user_addr, user_private_key, ...action_span]`. The action span is decoded against `PrivacyPoolABI`. A Deposit triggers a screen of its depositor, and an invoke funding open notes triggers one of either the shadow account it runs through or the target itself, depending on the target's policy. See `src/rpc.ts` for envelope validation and the calldata-layout comments above `isSinglePoolCall` in `src/pool-transaction.ts` for the field-by-field breakdown.

### Response shapes

```json
// allow, non-deposit / bypass case (no attestation needed)
{ "jsonrpc": "2.0", "id": 1, "result": { "allowed": true } }

// allow, screened deposit — carries the signature to relay to the prover
// (the prover attaches it under additional_data.signature on the prove response)
{ "jsonrpc": "2.0", "id": 1,
  "result": { "allowed": true,
              "signature": { "issued_at": 1716579600,
                             "sig_r": "0x...", "sig_s": "0x..." } } }

// block — sanction match. Reason is an opaque code (never the depositor address).
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": 10000, "message": "Transaction rejected",
             "data": "address_blocked" } }

// block — screening/signing unavailable (fail-closed)
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": 10000, "message": "Transaction rejected",
             "data": "screening_unavailable" } }

// envelope rejection — prover treats as inconclusive, not a block
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": 61, "message": "Unsupported tx version",
             "data": "Only version 0x3 is supported, got: 0x1" } }
```

## Security boundaries

- **Silent pass-through.** Missing `SCREENING_URL` makes the service a no-op that returns `allowed: true` for every transaction; `/health` is unchanged. The worst possible failure mode for a screening gate. Verify on every deploy that `proof_interceptor_screening_results_total != 0` and a known-sanctioned address returns code `10000`.
- **Unauthenticated listener.** No API key, no mTLS, no application-level ACL. Anything that can route to the listener becomes a free screening oracle for Elliptic's blocklist and can burn your partner-secret quota. Mitigations live entirely in network layout: `HOST=127.0.0.1` (loopback, in-pod sidecar), or `HOST=0.0.0.0` paired with a NetworkPolicy that allows ingress only from the prover and the approved Prometheus scraper. Do not expose this service via Service/Ingress without that NetworkPolicy.
- **`user_addr` is the only screened address.** `sender_address`, token addresses, withdrawal recipients, and addresses inside other calls are not screened. The compliance correctness of this service rests on the contract's invariant that deposits debit `user_addr`'s balance. Review pool-contract deposit semantics whenever they change.
- **ABI drift.** Pool-contract upgrades that aren't reflected in the SDK pin cause `hasDepositAction` to silently `catch` and return `false` — every Deposit during the mismatch window is allowed without screening. Bump `@starkware-libs/starknet-privacy-sdk` in lock-step with pool-contract upgrades; consider a CI check that decodes a known-good Deposit fixture against the SDK on every deploy.
- **Fail-open layering.** Two independent fail-open knobs, and they do **not** default the same way: `SCREENING_FAIL_OPEN` here defaults false (blocks when this service can't reach the proxy), while `blocking_check_fail_open` in the prover's `config.json` defaults **true** — every Inconclusive outcome in the table above, including an envelope rejection this service returns deliberately, then yields a proof for an unscreened transaction. Set it to false in the deployment; the prover's own default is not the safe one. Fail-open allowances increment the same `result="allowed"` counter as real allows; the only signal is the `screening_failed` log line.

## Metrics

Prometheus counters/histograms exported on `/metrics` (defined in `src/metrics.ts`):

- `proof_interceptor_screening_results_total{result}` — `allowed` / `blocked` / `unavailable`. The primary signal that screening is wired up at all.
- `proof_interceptor_screening_retries_total` — retry attempts only (first attempts excluded).
- `proof_interceptor_screening_policy_reads_total{result}` — open-note screening policies read from the pool: `Required` / `Exempt` / `Delegated`; `pre_policy_pool` when the pool has no policy entrypoint and every open-note depositor reads as exempt; or `unavailable` when the read failed and the flow fails closed.
- `proof_interceptor_screening_duration_seconds{result}` — Elliptic round-trip latency.
- `proof_interceptor_interceptor_verdicts_total{interceptor,verdict}` — per-interceptor verdicts.
- `proof_interceptor_rpc_requests_total{action,method}` and `proof_interceptor_errors_total{type}` — request and error counters.

Plus default Node.js process metrics from `prom-client`.

## Verifying a deployment

```bash
# liveness
curl -fsS http://<pod>:8080/health    # → {"status":"ok"}

# screening is actually exercised (the only check that catches silent pass-through)
curl http://<pod>:8080/metrics | grep proof_interceptor_screening_results_total
```

If `proof_interceptor_screening_results_total` stays at zero after real traffic, `SCREENING_URL` is probably unset.

## Development

```bash
npm ci
(cd ../elliptic-proxy && npm ci)   # tests/e2e.test.ts imports its source, so lint resolves its deps
npm run build       # tsc -p tsconfig.build.json → dist/
npm test            # vitest run
npm run lint        # prettier + eslint + tsc --noEmit (src and tests)
npm run format      # auto-fix
```

Run locally without screening (no-op pass-through, intended for testing the request-handling path only):

```bash
PORT=8080 npm start
```

Run locally with screening pointed at a real elliptic-proxy:

```bash
SCREENING_URL=https://<proxy-host> \
SCREENING_PARTNER_NAME=<partner-name> \
SCREENING_PARTNER_SECRET=<base64-secret> \
SCREENING_POOL_ADDRESS=0x... \
SCREENING_RPC_URL=https://<starknet-rpc> \
PORT=8080 \
npm start
```

## Source map

| File                           | Responsibility                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                 | Entry point — loads config, builds the handler, starts the server, wires graceful shutdown               |
| `src/config.ts`                | Environment-variable parsing and validation                                                              |
| `src/server.ts`                | HTTP/HTTPS server bootstrap                                                                              |
| `src/proxy.ts`                 | Top-level request handler — routing (`/`, `/health`, `/metrics`), body limits, JSON-RPC error mapping    |
| `src/rpc.ts`                   | JSON-RPC envelope and `starknet_checkTransaction` parameter validation                                   |
| `src/interceptor.ts`           | Parallel interceptor runner with first-block-wins semantics                                              |
| `src/pool-transaction.ts`      | Pool-call gate and client-action decoding of a prove request's calldata                                  |
| `src/shadow-account.ts`        | The shadow account interaction a transaction runs on the anonymizer, from its decoded actions            |
| `src/screened-address.ts`      | The address a transaction is screened for: depositor, shadow account, or a `Required` invoke target      |
| `src/screening-policy.ts`      | Open-note screening policies read from the pool over RPC, cached per depositor with an LRU TTL           |
| `src/screening-interceptor.ts` | Deposit detection, address extraction, retry/timeout, HMAC-signed call to elliptic-proxy                 |
| `src/types.ts`                 | JSON-RPC and `ProveTxnV3` types                                                                          |
| `src/metrics.ts`               | Prometheus registry and metric definitions                                                               |
| `src/shutdown.ts`              | SIGTERM/SIGINT handlers                                                                                  |
| `tests/`                       | Vitest unit and end-to-end tests                                                                         |
