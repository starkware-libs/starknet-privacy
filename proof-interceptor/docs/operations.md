# Operations

Reference for operators running the proof-interceptor: complete environment-variable surface, Prometheus metrics, deployment notes, smoke tests, and alerting recommendations.

For onboarding context and the production-policy summary, see the top-level [`README.md`](../README.md). For the security implications behind several of the configuration choices, see [`security-boundaries.md`](security-boundaries.md).

## Configuration

All configuration is environment variables. See `src/config.ts`.

| Env var | Required | Default | Description |
|---|---|---|---|
| `SCREENING_URL` | enables screening | -- | Base URL of the elliptic-proxy (no trailing path). **This is the toggle**: if unset, screening is skipped entirely and every transaction is allowed through, regardless of the other `SCREENING_*` vars. |
| `SCREENING_PARTNER_NAME` | yes(1) | -- | Partner identifier issued by the proxy operator |
| `SCREENING_PARTNER_SECRET` | yes(1) | -- | Base64-encoded HMAC key issued by the proxy operator |
| `SCREENING_POOL_ADDRESS` | yes(1) | -- | Privacy-pool contract address; transactions to other contracts bypass screening (or are blocked, depending on `SCREENING_BLOCK_NON_POOL_TX`) |
| `SCREENING_TIMEOUT_MS` | no | `10000` | Per-attempt HTTP timeout to the proxy |
| `SCREENING_TOTAL_TIMEOUT_MS` | no | `10000` | Overall deadline shared across all retry attempts |
| `SCREENING_MAX_RETRIES` | no | `2` | Number of *retries* after the initial attempt |
| `SCREENING_FAIL_OPEN` | no | `false` | If `true`, transactions are allowed when screening is unavailable; default is fail-closed |
| `SCREENING_BLOCK_NON_POOL_TX` | no | `false` | If `true`, INVOKEs that aren't a single direct call to `SCREENING_POOL_ADDRESS` are blocked outright instead of bypassing screening. **Recommended `true` for production.** |
| `PORT` | no | `8080` | TCP port to listen on |
| `HOST` | no | `0.0.0.0` | Listen address. Prefer `127.0.0.1` for strict isolation (loopback-only, in-pod sidecar, metrics relayed). Use `0.0.0.0` only when direct Prometheus scraping of the Pod IP is required, and pair it with a NetworkPolicy allowing ingress only from the prover Pod and the approved scraper. See [Recommended topology](#recommended-topology). |
| `MAX_BODY_BYTES` | no | `5242880` (5 MiB) | Max accepted JSON-RPC body size |
| `TLS_CERT_PATH` | no(2) | -- | PEM cert path; if set, server runs HTTPS |
| `TLS_KEY_PATH` | no(2) | -- | PEM key path; required iff `TLS_CERT_PATH` is set |

(1) Required *only when `SCREENING_URL` is set*. The service uses `SCREENING_URL` alone as the on/off switch: setting it triggers loading and validation of `SCREENING_PARTNER_NAME`, `SCREENING_PARTNER_SECRET`, and `SCREENING_POOL_ADDRESS` (missing any of them throws on startup). Leaving `SCREENING_URL` unset disables screening even if the other three are set -- they are silently ignored.

(2) `TLS_CERT_PATH` and `TLS_KEY_PATH` must both be set or both absent.

## Metrics

Prometheus counters and histograms exported on `/metrics` (`src/metrics.ts`):

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `proof_interceptor_rpc_requests_total` | counter | `action`, `method` | JSON-RPC requests handled (per RPC method, plus an `error` action for malformed requests) |
| `proof_interceptor_interceptor_verdicts_total` | counter | `interceptor`, `verdict` | Verdicts produced per interceptor (`allow` / `block`) |
| `proof_interceptor_interceptor_duration_seconds` | histogram | `interceptor`, `verdict` | Time inside each interceptor's `intercept()` |
| `proof_interceptor_screening_results_total` | counter | `result` | Outcomes of `screenAddress` calls (`allowed` / `blocked` / `unavailable`) |
| `proof_interceptor_screening_retries_total` | counter | -- | Retry attempts (does not count first attempts) |
| `proof_interceptor_screening_duration_seconds` | histogram | `result` | Latency of completed Elliptic round-trips |
| `proof_interceptor_request_duration_seconds` | histogram | `action` | Total handler time per RPC request |
| `proof_interceptor_in_flight_requests` | gauge | -- | Current concurrent requests |
| `proof_interceptor_errors_total` | counter | `type` | Internal errors (malformed body, interceptor exception, oversized payload) |

Plus the default Node.js process metrics from `prom-client` (`process_cpu_seconds_total`, `nodejs_heap_size_total_bytes`, etc.).

## Deployment

Multi-arch images (`linux/amd64`, `linux/arm64`) are published to GHCR on every release tag by `.github/workflows/proof-interceptor-docker.yaml`:

```
ghcr.io/starkware-libs/starknet-privacy/proof-interceptor:<tag>
```

Pin to a release tag -- never `latest` or `main`. Mutable tags can leave a Pod running an old binary against a new ABI.

### Recommended topology

Deploy as an in-pod sidecar to the prover. The host binding is a deliberate tradeoff between security and metrics scraping; pick one of the two configurations below before deploying.

**Strict same-Pod (default-secure):** set `HOST=127.0.0.1`. The listener binds to loopback only, reachable only from inside the Pod's network namespace. The prover talks to the sidecar over `localhost:8080`, no Kubernetes Service is required, and the unauthenticated HTTP listener is unreachable from outside the Pod -- including from a Prometheus scraper trying to hit the Pod IP. **Direct Pod scraping requires `HOST=0.0.0.0`; loopback-only binding prevents Prometheus from scraping the Pod IP.** If you pick this configuration, expose sidecar metrics through the prover (a small relay endpoint that proxies `localhost:8080/metrics`) or via a local metrics agent that runs in the same Pod and forwards.

**Permissive listener with network ACL:** set `HOST=0.0.0.0` so the Pod IP is reachable, then restrict ingress with a NetworkPolicy that allows only the prover Pod and the approved Prometheus scraper. This is required for direct Pod-IP scraping. It is also the only configuration that supports a separate-Deployment sidecar, since cross-Pod connections cannot use loopback.

Co-locating in the same Pod is *not* by itself the security boundary. The default `HOST=0.0.0.0` binds to every interface, including the Pod IP, which is reachable from other Pods unless a NetworkPolicy blocks them.

Configure the prover with `blocking_check_url=http://localhost:8080`.

### Cross-Pod deployment (only if the in-pod sidecar isn't possible)

If the sidecar must run as a separate Deployment (e.g., independent scaling), the listener has to accept connections from another Pod, so `HOST=0.0.0.0` is unavoidable. The service has **no application-level authentication**, so the security model is entirely network-layer:

- **Required:** a NetworkPolicy that allows ingress only from the prover Pod's labels (and the approved Prometheus scraper), and denies all other ingress. This is the actual access-control boundary.
- **Optional but recommended:** server-side TLS via `TLS_CERT_PATH` and `TLS_KEY_PATH`. This encrypts traffic between the prover and the sidecar; it does **not** authenticate the client. The Node.js HTTPS server is configured with `cert` and `key` only (`src/server.ts`); there is no `ca`, `requestCert`, or `rejectUnauthorized: true`, so any caller that satisfies the NetworkPolicy can complete the TLS handshake.
- **For real mutual authentication:** put a service mesh (Istio, Linkerd, Cilium, etc.) or an envoy/ambassador-style proxy in front of the sidecar that enforces mTLS, and rely on the mesh to authenticate the prover. This service does not implement client-certificate verification itself.

Without the NetworkPolicy, the listener is an unauthenticated screening oracle for any in-cluster adversary that can route to the sidecar Pod IP. See [`security-boundaries.md`](security-boundaries.md#unauthenticated-listener) for the exposure model.

### Metrics scraping

Direct Pod scraping (`PodMonitor` or pod-scrape annotations on the sidecar) requires `HOST=0.0.0.0`; loopback-only binding (`HOST=127.0.0.1`) prevents Prometheus from reaching the Pod IP at all. Two options:

- **Loopback-only sidecar (recommended for security):** keep `HOST=127.0.0.1` and expose metrics through a local relay -- typically a small `/metrics` proxy on the prover container that forwards `localhost:8080/metrics`, or a metrics-collecting agent (Vector, OpenTelemetry Collector, etc.) running in the same Pod. Prometheus scrapes the prover or the agent; the sidecar itself stays loopback-only.
- **Direct Pod scrape:** set `HOST=0.0.0.0` so the Pod IP is reachable, then add a NetworkPolicy that allows ingress to port 8080 from the prover Pod *and* from the Prometheus scraper, denying everything else. Without the NetworkPolicy, the JSON-RPC screening endpoint is also reachable to any Pod the cluster network permits.

Do **not** create a Kubernetes Service for the sidecar just to expose `/metrics` without a NetworkPolicy in place -- that re-introduces the cross-Pod-reachability problem with no compensating ACL.

## Smoke tests

After deployment, run these to confirm the gate is actually active.

### 1. Sidecar liveness

```bash
kubectl exec -n <namespace> deploy/transaction-prover -c proof-interceptor -- \
  curl -fsS http://localhost:8080/health
# expected: {"status":"ok"}
```

A healthy `/health` on its own is **not** evidence that screening is wired up -- see the silent pass-through hazard below.

### 2. Verify screening is exercised

Send a known-sanctioned test address through the prover and confirm:

- The client receives JSON-RPC error `10000` ("Transaction rejected") with `data: "address screening: <addr> blocked"`.
- `proof_interceptor_screening_results_total{result="blocked"}` increments by 1.

Send a known-clean address and confirm:

- The client receives a proof.
- `proof_interceptor_screening_results_total{result="allowed"}` increments by 1.

If neither metric moves, `SCREENING_URL` is probably unset -- the service is silently passing every transaction through. This is the worst possible failure mode for a screening gate.

### 3. Confirm production toggles

```bash
kubectl exec -n <namespace> deploy/transaction-prover -c proof-interceptor -- \
  env | grep '^SCREENING_'
```

Verify (for production):

- `SCREENING_URL=https://...` -- present
- `SCREENING_BLOCK_NON_POOL_TX=true`
- `SCREENING_FAIL_OPEN` -- absent or `false`
- Listener binding -- one of:
  - `HOST=127.0.0.1` for strict-isolation deployments (in-pod sidecar with metrics relayed via the prover or a co-located collector); or
  - `HOST=0.0.0.0` (or unset, which defaults to it) **only with** a NetworkPolicy that restricts ingress to the prover Pod and the approved Prometheus scraper. Verify the NetworkPolicy independently; the env var alone is not sufficient.

## Alerting

Recommended alerts:

- **Screening unavailable, fail-closed.** `rate(proof_interceptor_screening_results_total{result="unavailable"}[5m]) > 0` -- every unavailability is a blocked deposit.
- **Sidecar absorbing errors.** `rate(proof_interceptor_errors_total[5m]) > 0` -- internal exceptions, oversized payloads, or interceptor errors.
- **Unexpected verdict mix.** Sudden swing in the ratio of `allowed` vs. `blocked` vs. `unavailable` indicates either a compromised key, a spike in adversarial traffic, or upstream proxy/Elliptic problems.
- **Fail-open allowances** *(only if you have set `SCREENING_FAIL_OPEN=true`)*: alert on `screening_failed` log lines. Fail-open allowances increment the same `result="allowed"` counter as real allows, so log-based alerting is the only way to surface them.
- **Health check failing.** Standard Kubernetes liveness/readiness coverage.

## Local development

Run locally without screening (no-op pass-through, intended for testing the request-handling path only):

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

For an end-to-end credential sanity check that does not require deploying anything, see the HMAC signing snippet in [`api.md`](api.md#hmac-signing-snippet).
