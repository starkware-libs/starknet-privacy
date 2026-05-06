# proof-interceptor

JSON-RPC service that screens privacy-pool deposit transactions against OFAC sanctions before the transaction prover produces a proof. It sits alongside the prover as an in-pod sidecar and is called by the prover, not by end clients.

The prover stays the public entry point of the system; client APIs do not change. Screening is invisible from the outside -- when a transaction is allowed the client gets a proof as usual, when it is blocked the client gets JSON-RPC error code `10000` ("Transaction rejected").

> **Production policy at a glance:** fail-closed at both layers (defaults), `SCREENING_BLOCK_NON_POOL_TX=true`, listener binding chosen deliberately (prefer `HOST=127.0.0.1` unless direct Prometheus scraping requires `HOST=0.0.0.0` plus a NetworkPolicy restricting ingress to the prover and the approved scraper), `SCREENING_URL` set, SDK pinned to match the deployed pool contract. The shipped defaults are biased toward "don't break unrelated transaction flows" rather than "be a strict compliance gate"; production must opt into the strict path. See [Production safety checklist](#production-safety-checklist) below and [`docs/security-boundaries.md`](docs/security-boundaries.md) for the rationale.

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

The prover is the public entry point and runs the screening round-trip in parallel with proving:

1. **Client -> Prover**: `starknet_proveTransaction`.
2. **Prover -> proof-interceptor** (on `localhost:8080`): `starknet_checkTransaction`, fired in parallel with proving.
3. **proof-interceptor -> elliptic-proxy**: HMAC-signed `POST /screen` for each address that needs screening.
4. **elliptic-proxy -> Elliptic AML API**: the upstream sanctions check (cached at the proxy).

Verdicts flow back along the same path. This service is stateless; verdicts are cached in `elliptic-proxy`, not here.

For the full step-by-step (envelope validation, calldata layout, deposit decoding, retry/budget behavior, verdict resolution), see [`docs/screening-flow.md`](docs/screening-flow.md).

## What gets screened

| Category | Verdict | When |
|---|---|---|
| **Screened** | depends on Elliptic | Single direct INVOKE-v3 to `SCREENING_POOL_ADDRESS` carrying a Deposit action. The depositor address (`user_addr`, `inner_calldata[0]`) is sent to elliptic-proxy. |
| **Bypass (non-pool)** | `allow` | Multi-call INVOKEs, calls to contracts other than `SCREENING_POOL_ADDRESS`, and pool calls whose `calldata[0]`/address is non-canonically encoded (`"0x01"`, `"0X1"`, case-mismatched address). Set `SCREENING_BLOCK_NON_POOL_TX=true` to block all of these instead. |
| **Bypass (pool, no Deposit)** | `allow` | Pool calls with no Deposit action (withdraw-only) or whose action span fails to decode (most often ABI drift). **Not affected by `SCREENING_BLOCK_NON_POOL_TX`** -- this toggle only changes the non-pool branch. |
| **Blocked** | RPC error `10000` | Sanctioned `user_addr`, screening-pipeline failure with fail-closed defaults, or any unhandled exception inside an interceptor (caught and converted to a block with the exception message as the reason). |
| **Inconclusive** | RPC error other than `10000`, or no response at all | Envelope rejection (e.g. RPC error `61` "Unsupported tx version"), network error talking to the sidecar, timeout, or any non-`10000` RPC error. The prover decides what to do via its `blocking_check_fail_open` setting. |

Per-shape decision table covering every transaction type and failure mode is in [`docs/security-boundaries.md`](docs/security-boundaries.md#decision-table).

## Production safety checklist

Defaults are deployment-friendly, not security-strict. Apply these for production:

- **`SCREENING_BLOCK_NON_POOL_TX=true`** -- converts the multi-call bypass and the non-canonical-felt bypass into blocks. The single most important toggle.
- **`SCREENING_FAIL_OPEN=false`** and **prover-side `blocking_check_fail_open=false`** -- both default false; verify in deployment.
- **Choose listener binding deliberately.** The service has no application-level authentication, so the host binding is the security boundary. Prefer `HOST=127.0.0.1` when `/metrics` does not need to be scraped directly from the proof-interceptor Pod IP -- this keeps the sidecar reachable only by the co-located prover. Use `HOST=0.0.0.0` only when direct Prometheus scraping or cross-Pod access is required, and pair it with a NetworkPolicy restricting ingress to the transaction prover and the approved metrics scraper. Co-locating in the same Pod is *not* by itself the boundary: with the default `HOST=0.0.0.0`, the listener is reachable from any Pod that can route to this Pod's IP, which is most of the cluster absent a NetworkPolicy.
- **`TLS_CERT_PATH`/`TLS_KEY_PATH` are server-side TLS only.** They encrypt the connection between the prover and the sidecar but do *not* authenticate the client -- the HTTPS server is configured with `cert`/`key` only, not `requestCert`/`ca`. For real mTLS, put a service mesh (Istio, Linkerd, etc.) or proxy in front of this service that enforces it. Treat the env-var TLS as transport encryption, not access control.
- **Verify `SCREENING_URL` is set.** Without it, the service runs as a no-op pass-through that always returns `allowed: true` -- `/health` still reports OK. Confirm with `proof_interceptor_screening_results_total` non-zero on `/metrics`.
- **Pin `@starkware-libs/starknet-privacy-sdk`** to a version whose `PrivacyPoolABI` matches the deployed pool contract. ABI drift causes silent fail-open on Deposit detection.

Each item is expanded with attack scenarios and mitigations in [`docs/security-boundaries.md`](docs/security-boundaries.md).

## Configuration

The four `SCREENING_*` env vars below are required when screening is enabled (the production case):

| Env var | Purpose |
|---|---|
| `SCREENING_URL` | Base URL of the elliptic-proxy. Setting this is what enables screening -- leaving it unset is the silent-pass-through hazard. |
| `SCREENING_PARTNER_NAME` | Partner identifier issued by the proxy operator. |
| `SCREENING_PARTNER_SECRET` | Base64-encoded HMAC key issued by the proxy operator. |
| `SCREENING_POOL_ADDRESS` | Privacy-pool contract address -- only direct calls to this address are screened. |

Plus the production-toggle `SCREENING_BLOCK_NON_POOL_TX=true` discussed above.

Full env-var reference (timeouts, retries, port, host, TLS, body-size limits) in [`docs/operations.md`](docs/operations.md#configuration).

## HTTP endpoints

| Path | Method | Description |
|---|---|---|
| `/` | POST | JSON-RPC entrypoint. Only `starknet_checkTransaction` is accepted. |
| `/health` | GET | Liveness/readiness. Returns `200 {"status":"ok"}`. |
| `/metrics` | GET | Prometheus metrics. |

JSON-RPC request/response examples (allow, block, envelope rejection) and the HMAC signing snippet for testing credentials are in [`docs/api.md`](docs/api.md).

## Integration checklist

Before relying on this service to gate a production prover:

- [ ] Obtain partner credentials from the proxy operator.
- [ ] Verify the credentials authenticate against the proxy from your laptop *before* deploying the sidecar (HMAC snippet in [`docs/api.md`](docs/api.md#hmac-signing-snippet)).
- [ ] Apply the [production safety checklist](#production-safety-checklist) settings.
- [ ] Pin the SDK to a version whose `PrivacyPoolABI` matches the deployed pool contract; coordinate pool upgrades with SDK bumps and redeploys.
- [ ] Confirm the pool contract's deposit semantics match the assumption that `inner_calldata[0]` (`user_addr`) is the actual fund source.
- [ ] Choose listener binding deliberately. Use `HOST=127.0.0.1` (loopback-only, in-pod sidecar) when metrics are relayed by the prover or a co-located collector. Use `HOST=0.0.0.0` only when direct Prometheus scraping or cross-Pod access is required, and pair it with a NetworkPolicy allowing ingress only from the prover Pod and the approved scraper. Do *not* expose this service via a Service or Ingress without that NetworkPolicy. See [`docs/operations.md`](docs/operations.md#recommended-topology) for both options and [`docs/operations.md`](docs/operations.md#cross-pod-deployment-only-if-the-in-pod-sidecar-isnt-possible) for the limits of `TLS_CERT_PATH`/`TLS_KEY_PATH`.
- [ ] Pin a release-tag image, never `latest` or `main`.
- [ ] Wire metrics scraping. Direct sidecar scraping (`PodMonitor` or pod-scrape annotations) requires `HOST=0.0.0.0`; with `HOST=127.0.0.1` the Pod IP is unreachable to Prometheus, so route metrics through a prover relay or a local collector running in the same Pod.
- [ ] Smoke-test end-to-end with a known-sanctioned address; confirm error code `10000` and a `proof_interceptor_screening_results_total{result="blocked"}` increment. See [`docs/operations.md`](docs/operations.md#smoke-tests).
- [ ] Add an alert on `screening_failed` log lines if you've enabled `SCREENING_FAIL_OPEN=true` (fail-open allowances are not distinguishable from real allows in metrics).

## Documentation

- [`docs/screening-flow.md`](docs/screening-flow.md) -- calldata layout, deposit detection, retry behavior, full step-by-step flow.
- [`docs/security-boundaries.md`](docs/security-boundaries.md) -- decision table, the eight policy boundaries (multi-call bypass, non-canonical-felt bypass, withdraws not screened, ABI drift, `user_addr` trust assumption, unauthenticated listener, fail-open layering, silent pass-through), attack scenarios and mitigations.
- [`docs/operations.md`](docs/operations.md) -- full env-var reference, Prometheus metrics, deployment notes, smoke tests, alerting.
- [`docs/api.md`](docs/api.md) -- JSON-RPC request/response examples, calldata-layout breakdown, HMAC signing snippet.

## Development

```bash
npm ci
npm run build       # tsc -> dist/
npm test            # vitest run
npm run lint        # prettier + eslint + tsc --noEmit
npm run format      # auto-fix
```

Run locally without screening (no-op pass-through):

```bash
PORT=8080 npm start
```

Run locally with screening pointed at a real `elliptic-proxy`:

```bash
SCREENING_URL=https://<proxy-host> \
SCREENING_PARTNER_NAME=<partner-name> \
SCREENING_PARTNER_SECRET=<base64-secret> \
SCREENING_POOL_ADDRESS=0x... \
PORT=8080 \
npm start
```

## Source map

| File | Responsibility |
|---|---|
| `src/index.ts` | Entry point -- loads config, builds the handler, starts the server, wires graceful shutdown |
| `src/config.ts` | Environment-variable parsing and validation |
| `src/server.ts` | HTTP/HTTPS server bootstrap |
| `src/proxy.ts` | Top-level request handler -- routing (`/`, `/health`, `/metrics`), body limits, JSON-RPC error mapping |
| `src/rpc.ts` | JSON-RPC envelope and `starknet_checkTransaction` parameter validation |
| `src/interceptor.ts` | Parallel interceptor runner with first-block-wins semantics |
| `src/screening-interceptor.ts` | Pool-call gate, deposit detection, address extraction, retry/timeout, HMAC-signed call to elliptic-proxy |
| `src/types.ts` | JSON-RPC and `ProveTxnV3` types |
| `src/metrics.ts` | Prometheus registry and metric definitions |
| `src/shutdown.ts` | SIGTERM/SIGINT handlers |
| `tests/` | Vitest unit and end-to-end tests |
