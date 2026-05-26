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

The prover runs the screening round-trip in parallel with proving. The sidecar receives one `starknet_checkTransaction` per client `starknet_proveTransaction`, decodes the deposit action span using `PrivacyPoolABI` from `@starkware-libs/starknet-privacy-sdk`, and screens `user_addr` via HMAC-signed `POST /screen` to elliptic-proxy. This service is stateless; verdicts are cached in elliptic-proxy. The HMAC scheme (SHA-256 over `timestamp || method || path.toLowerCase() || body`, base64-decoded partner secret as the key) lives in `src/screening-interceptor.ts:computeHmacSignature` — use that as the reference if you need to verify partner credentials independently.

## What gets screened

| Category                      | Verdict                                             | When                                                                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Screened**                  | depends on Elliptic                                 | Single direct INVOKE-v3 to `SCREENING_POOL_ADDRESS` carrying a Deposit action. The depositor address (`user_addr`, `inner_calldata[0]`) is sent to elliptic-proxy.                                                                                                    |
| **Bypass (non-pool)**         | `allow`                                             | Multi-call INVOKEs, calls to contracts other than `SCREENING_POOL_ADDRESS`, and pool calls whose `calldata[0]`/address is non-canonically encoded (`"0x01"`, `"0X1"`, case-mismatched address). Set `SCREENING_BLOCK_NON_POOL_TX=true` to block all of these instead. |
| **Bypass (pool, no Deposit)** | `allow`                                             | Pool calls with no Deposit action (withdraw-only) or whose action span fails to decode (most often ABI drift). **Not affected by `SCREENING_BLOCK_NON_POOL_TX`** — this toggle only changes the non-pool branch.                                                      |
| **Blocked**                   | RPC error `10000`                                   | Sanctioned `user_addr`, screening-pipeline failure with fail-closed defaults, or any unhandled exception inside an interceptor (caught and converted to a block with the exception message as the reason).                                                            |
| **Inconclusive**              | RPC error other than `10000`, or no response at all | Envelope rejection (e.g. RPC error `61` "Unsupported tx version"), network error talking to the sidecar, timeout, or any non-`10000` RPC error. The prover decides what to do via its `blocking_check_fail_open` setting.                                             |

## Production safety checklist

Defaults are deployment-friendly, not security-strict. Apply these for production:

- **`SCREENING_BLOCK_NON_POOL_TX=true`** — converts the multi-call bypass and the non-canonical-felt bypass into blocks. The single most important toggle.
- **`SCREENING_FAIL_OPEN=false`** and **prover-side `blocking_check_fail_open=false`** — both default false; verify in deployment.
- **Choose listener binding deliberately.** The service has no application-level authentication, so the host binding is the security boundary. Prefer `HOST=127.0.0.1` (loopback-only, in-pod sidecar) when metrics can be relayed by the prover or a co-located collector. Use `HOST=0.0.0.0` only when direct Prometheus scraping of the Pod IP is required, and pair it with a NetworkPolicy restricting ingress to the prover and the approved scraper. Co-location in the same Pod is _not_ by itself the boundary: with `HOST=0.0.0.0`, the listener is reachable from any Pod that can route to this Pod's IP.
- **`TLS_CERT_PATH`/`TLS_KEY_PATH` are server-side TLS only.** They encrypt the prover↔sidecar connection but do _not_ authenticate the client (no `requestCert`/`ca` is configured in `src/server.ts`). For real mTLS, put a service mesh or proxy in front of the sidecar.
- **Verify `SCREENING_URL` is set.** Without it, the service runs as a no-op pass-through that always returns `allowed: true` — `/health` still reports OK. Confirm `proof_interceptor_screening_results_total` is non-zero on `/metrics`.
- **Pin `@starkware-libs/starknet-privacy-sdk`** to a version whose `PrivacyPoolABI` matches the deployed pool contract. ABI drift causes silent fail-open on Deposit detection.

## Configuration

Required when screening is enabled (the production case):

| Env var                    | Purpose                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `SCREENING_URL`            | Base URL of the elliptic-proxy. Setting this is what enables screening — leaving it unset is the silent-pass-through hazard. |
| `SCREENING_PARTNER_NAME`   | Partner identifier issued by the proxy operator.                                                                             |
| `SCREENING_PARTNER_SECRET` | Base64-encoded HMAC key issued by the proxy operator.                                                                        |
| `SCREENING_POOL_ADDRESS`   | Privacy-pool contract address — only direct calls to this address are screened.                                              |

Plus the production toggle `SCREENING_BLOCK_NON_POOL_TX=true` discussed above. Optional knobs (`SCREENING_TIMEOUT_MS`, `SCREENING_TOTAL_TIMEOUT_MS`, `SCREENING_MAX_RETRIES`, `SCREENING_FAIL_OPEN`, `PORT`, `HOST`, `MAX_BODY_BYTES`, `TLS_CERT_PATH`/`TLS_KEY_PATH`) and their defaults are in `src/config.ts`.

## HTTP endpoints

| Path       | Method | Description                                                                                                           |
| ---------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `/`        | POST   | JSON-RPC entrypoint. Only `starknet_checkTransaction` is accepted; everything else returns `-32601 Method not found`. |
| `/health`  | GET    | Liveness/readiness. Returns `200 {"status":"ok"}` when healthy, `503 {"status":"unhealthy","interceptors":[{"name":"...","reason":"..."}]}` when any registered interceptor reports `healthy: false`. See [Health checks](#health-checks). |
| `/metrics` | GET    | Prometheus metrics. See [Metrics](#metrics). |

Every HTTP response carries an `x-request-id` header. Inbound `x-request-id` is accepted only when
it's a short printable-ASCII token; otherwise a fresh UUID is generated. The id appears in every
log line for the request so failures can be correlated by quoting a single id.

### Request

The body mirrors `starknet_proveTransaction` exactly (object or positional params). The screened shape is a single direct INVOKE-v3 to `SCREENING_POOL_ADDRESS` with `calldata = [call_count=1, contract_address=pool, selector, inner_len, user_addr, user_private_key, ...action_span]`. The action span is decoded against `PrivacyPoolABI`; only the Deposit variant triggers a screen. See `src/rpc.ts` for envelope validation and the calldata-layout comments above `isSinglePoolCall` in `src/screening-interceptor.ts` for the field-by-field breakdown.

### Response shapes

```json
// allow (and every bypass case)
{ "jsonrpc": "2.0", "id": 1, "result": { "allowed": true } }

// block — sanction match
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": 10000, "message": "Transaction rejected",
             "data": "address screening: 0x... blocked" } }

// block — screening unavailable (fail-closed default)
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": 10000, "message": "Transaction rejected",
             "data": "screening unavailable for 0x..." } }

// envelope rejection — prover treats as inconclusive, not a block
{ "jsonrpc": "2.0", "id": 1,
  "error": { "code": 61, "message": "Unsupported tx version",
             "data": "Only version 0x3 is supported, got: 0x1" } }
```

## Security boundaries

- **Silent pass-through.** Missing `SCREENING_URL` makes the service a no-op that returns `allowed: true` for every transaction; `/health` is unchanged. The worst possible failure mode for a screening gate. Verify on every deploy that `proof_interceptor_screening_results_total != 0` and a known-sanctioned address returns code `10000`.
- **Unauthenticated listener.** No API key, no mTLS, no application-level ACL. Anything that can route to the listener becomes a free screening oracle for Elliptic's blocklist and can burn your partner-secret quota. Mitigations live entirely in network layout: `HOST=127.0.0.1` (loopback, in-pod sidecar), or `HOST=0.0.0.0` paired with a NetworkPolicy that allows ingress only from the prover and the approved Prometheus scraper. Do not expose this service via Service/Ingress without that NetworkPolicy.
- **Non-canonical felt encodings.** The pool-call gate is sensitive to how `calldata[0]` and the contract address are encoded. `"0x01"`, `"0X1"`, and case-mismatched addresses all classify a real pool call as non-pool and bypass screening when `SCREENING_BLOCK_NON_POOL_TX=false`. Set it to `true` for production so non-canonical pool calls become blocks instead of silent passes.
- **`user_addr` is the only screened address.** `sender_address`, token addresses, withdrawal recipients, and addresses inside other calls are not screened. The compliance correctness of this service rests on the contract's invariant that deposits debit `user_addr`'s balance. Review pool-contract deposit semantics whenever they change.
- **ABI drift.** Pool-contract upgrades that aren't reflected in the SDK pin cause `hasDepositAction` to silently `catch` and return `false` — every Deposit during the mismatch window is allowed without screening. Bump `@starkware-libs/starknet-privacy-sdk` in lock-step with pool-contract upgrades; consider a CI check that decodes a known-good Deposit fixture against the SDK on every deploy.
- **Fail-open layering.** Two independent fail-open knobs: `SCREENING_FAIL_OPEN` here (default false; blocks when this service can't reach the proxy), and `blocking_check_fail_open` in the prover's `config.json` (default false; covers the case where the prover can't reach this service at all). Both default fail-closed. Fail-open allowances increment the same `result="allowed"` counter as real allows; the only signal is the `screening_failed` log line.

## Health checks

`/health` is unauthenticated and reports the screening pipeline's reachability — not just that
the process is running. Each registered interceptor may implement an optional `health()` method;
`/health` calls it for every interceptor on every probe.

| Status | Trigger |
|---|---|
| `200 OK` | All interceptors return `healthy: true`, or none implement `health()`. |
| `503 Service Unavailable` | At least one interceptor returns `healthy: false`. The response body lists the unhealthy interceptors by name and an opaque `reason` code; no timestamps, error counts, or upstream URLs are exposed. |

The screening interceptor reports unhealthy when the Elliptic proxy has been continuously
unreachable for `SCREENING_HEALTH_MAX_UNAVAILABLE_MS` (default 30 seconds). A short blip in
reachability does not flip `/health` to 503 — load balancers should only drain a pod when the
window has held. A single successful screening call clears the window immediately.

`/health` is intended for load-balancer probes; it must remain safe to expose without
authentication, which is why the body is opaque.

## Metrics

Prometheus counters/histograms exported on `/metrics` (defined in `src/metrics.ts`):

- `proof_interceptor_build_info{version,git_sha}` — always `1`. Used to identify the running build from a scrape, paired with the redacted startup banner.
- `proof_interceptor_screening_results_total{result}` — `allowed` / `blocked` / `unavailable`. The primary signal that screening is wired up at all.
- `proof_interceptor_screening_availability_total{outcome}` — Elliptic-proxy call outcomes, bucketed by category: `success`, `timeout`, `network_error`, `http_4xx`, `http_5xx`, `screening_error`. Distinguishes the *kind* of upstream failure rather than just counting unavailable verdicts.
- `proof_interceptor_screening_retries_total` — retry attempts only (first attempts excluded).
- `proof_interceptor_screening_duration_seconds{result}` — Elliptic round-trip latency.
- `proof_interceptor_interceptor_verdicts_total{interceptor,verdict}` — per-interceptor verdicts.
- `proof_interceptor_interceptor_errors_total{interceptor}` — per-interceptor error counter. Tagged with the interceptor name so per-interceptor failure rates are visible.
- `proof_interceptor_process_crashes_total{source}` — process-level crash counter incremented from `uncaughtException` / `unhandledRejection` handlers. Source is the originating event so logs and metrics agree on the crash class.
- `proof_interceptor_rpc_requests_total{action,method}` and `proof_interceptor_errors_total{type}` — request and error counters.

Label cardinality is bounded — no user-controlled values become labels. Plus default Node.js
process metrics from `prom-client`.

## Logging

Every HTTP request produces a single structured log line at `info` level with `event="request"`,
including `request_id`, `method`, `path`, `status`, and `latency_ms`. Request bodies are never
inspected — `user_addr` and pool-contract calldata are private user data, and the log stream is
treated as a potentially-untrusted sink.

The startup banner emits version + git SHA + redacted upstream URLs once at process start.
Credentials embedded in `SCREENING_URL` (e.g. `https://user:secret@elliptic.example.com/`) are
stripped down to `scheme://host[:port]` before logging.

`uncaughtException` and `unhandledRejection` are caught at process level and logged as
`event="uncaught_exception"` / `event="unhandled_rejection"` with the crash source, then the
process exits with code `1` — silent crashes are turned into noisy ones so the orchestrator
sees them. Graceful shutdown on `SIGTERM` / `SIGINT` logs `event="shutdown_started"` and
`event="shutdown_complete"` (or `event="shutdown_error"`) and ignores repeated signals while
shutdown is in flight.

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
npm run build       # tsc → dist/
npm test            # vitest run
npm run lint        # prettier + eslint + tsc --noEmit
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
| `src/screening-interceptor.ts` | Pool-call gate, deposit detection, address extraction, retry/timeout, HMAC-signed call to elliptic-proxy |
| `src/types.ts`                 | JSON-RPC and `ProveTxnV3` types                                                                          |
| `src/metrics.ts`               | Prometheus registry and metric definitions                                                               |
| `src/shutdown.ts`              | SIGTERM/SIGINT handlers                                                                                  |
| `tests/`                       | Vitest unit and end-to-end tests                                                                         |
