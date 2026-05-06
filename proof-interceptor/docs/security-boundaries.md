# Security and policy boundaries

This document expands on the production-policy summary in the top-level [`README.md`](../README.md). It covers what the service actually screens, what it deliberately does not, and the failure modes that operators need to account for. Every boundary below has a concrete trigger, a default behavior, and a recommended mitigation.

## Decision table

What the service does, by transaction shape and outcome.

| Transaction / outcome | Verdict to prover | Notes |
|---|---|---|
| Malformed JSON-RPC body or wrong envelope | RPC error `-32600` | Not a screening verdict; prover treats as inconclusive (see fail-open) |
| Method != `starknet_checkTransaction` | RPC error `-32601` | Same |
| Transaction `type` != `INVOKE` or `version` != `0x3` | RPC error `61` | Same -- matches prover error semantics |
| `block_id == "pending"` | RPC error `24` | Same |
| INVOKE v3, multi-call (`calldata[0] != "0x1"`) | **allow** | Bypasses screening by default. Set `SCREENING_BLOCK_NON_POOL_TX=true` to block these instead -- recommended for production (see [Multi-call bypass](#multi-call-bypass)). |
| INVOKE v3, single call to a contract != `SCREENING_POOL_ADDRESS` | **allow** | Same -- controlled by `SCREENING_BLOCK_NON_POOL_TX` |
| INVOKE v3, single pool call but `calldata[0]` is non-canonical (e.g. `"0x01"`, `"0X1"`) or address case differs | **allow** (treated as non-pool) | Gate uses literal-string compare; non-canonical felts and case-mismatched addresses fail the match, so `isSinglePoolCall` returns `false` and the request takes the same code path as a real non-pool call. See [Non-canonical felt encodings](#non-canonical-felt-encodings). Setting `SCREENING_BLOCK_NON_POOL_TX=true` converts this silent bypass to a block. |
| INVOKE v3, single pool call, no Deposit action in span | **allow** | Withdraw-only; nothing to screen |
| INVOKE v3, single pool call, action span fails to decode | **allow** | Decode `try/catch` returns `false`; the address is not screened. **Most likely root cause is ABI drift between the pool contract and this service's SDK pin** -- see [ABI drift](#abi-drift). |
| INVOKE v3, single pool call with Deposit, address is sanctioned | **block** | `code: 10000`, data: `address screening: <addr> blocked` |
| INVOKE v3, single pool call with Deposit, address is clean | **allow** | `result: { allowed: true }` |
| Same, all retries to elliptic-proxy fail, `SCREENING_FAIL_OPEN=false` (default) | **block** | data: `screening unavailable for <addr>` |
| Same, all retries fail, `SCREENING_FAIL_OPEN=true` | **allow** | Counted as `allowed` in metrics; only a `screening_failed` log line distinguishes it |
| Interceptor throws unexpected exception | **block** | data: the exception message |

## Recommended production configuration

Apply all of these on top of the shipped defaults:

- `SCREENING_BLOCK_NON_POOL_TX=true` -- converts the multi-call and non-canonical-felt bypasses into blocks (see below).
- `SCREENING_FAIL_OPEN=false` and prover-side `blocking_check_fail_open=false` -- both are the shipped defaults, but verify.
- Listener binding chosen deliberately. Prefer `HOST=127.0.0.1` (loopback-only, in-pod sidecar, metrics relayed) for strict isolation -- same-Pod co-location with the default `HOST=0.0.0.0` is *not* by itself the security boundary, since the listener is reachable from any Pod that can route to the Pod IP. If direct Prometheus scraping or cross-Pod access is required, keep `HOST=0.0.0.0` and pair it with a NetworkPolicy that restricts ingress to the prover Pod and the approved scraper. See the [Unauthenticated listener](#unauthenticated-listener) boundary for the exposure model.
- `SCREENING_URL` is set to a real URL -- the silent-pass-through fail mode is the worst possible outcome for a screening gate.
- `@starkware-libs/starknet-privacy-sdk` is pinned to a version whose `PrivacyPoolABI` matches the deployed pool contract; rev it in lock-step with pool-contract upgrades.

## The eight boundaries

### Multi-call bypass

A multi-call INVOKE (`calldata[0] != "0x1"`) -- even one whose sub-calls touch the pool -- bypasses screening by default. Same for single calls to *other* contracts. Bypass means **allow**, not block.

For production deployments, **prefer `SCREENING_BLOCK_NON_POOL_TX=true`** unless you have a stronger upstream invariant (e.g., the prover or contract already rejects multi-call deposits). The default is a permissive choice biased toward not breaking unrelated transaction flows; for a sanctions-compliance gate it's the wrong default. Set the env var explicitly even if you currently have no multi-call traffic -- it's a defense against adversaries crafting future bypass paths.

### Non-canonical felt encodings

The gate compares `calldata[0]` to the literal string `"0x1"` and the contract address to `SCREENING_POOL_ADDRESS` after stripping only leading zeros -- case is preserved. A starknet calldata field carrying the felt `1` may be serialized as `"0x1"`, `"0x01"`, `"0x001"`, or even `"0X1"` depending on the producer; the gate only matches the first form. Likewise, `0xABC...` (uppercase hex) and `0xabc...` (lowercase) for the same address compare as unequal.

A malicious or buggy client can therefore submit a *real* single direct pool call that the gate classifies as non-pool, bypassing screening when `SCREENING_BLOCK_NON_POOL_TX=false` (the default) -- or, more subtly, an honest client using a different encoder could miss screening without anyone noticing.

Mitigations, in order of preference:
- (a) Set `SCREENING_BLOCK_NON_POOL_TX=true` so non-canonical forms get blocked rather than silently passed.
- (b) Ensure upstream callers always submit canonical felts.

Monitoring from sidecar logs alone is not currently sufficient -- the service emits `{"screening":"non_pool_tx",...}` without the original `calldata`, so you cannot retrospectively distinguish a genuine non-pool call from a non-canonically-encoded pool call from sidecar telemetry. If you need that visibility, add request-side logging at the prover or extend `screening-interceptor.ts` to log a calldata fingerprint. The right code-side fix is to parse calldata felts before comparing, but at the documentation level you should know this gate is brittle to encoding choices.

### Withdraws are not screened

A pool call that contains only Withdraw actions is allowed without contacting Elliptic. Sanctions screening targets *new fund inflow*; withdrawals don't fit that model.

### ABI drift

If the action span fails to decode against `PrivacyPoolABI` (mismatched ABI version, garbage calldata, contract upgrade not yet reflected in the SDK), the call falls through to `allow` rather than blocking. The intent is "don't screen what you can't parse" rather than "block what you can't parse"; the failure is silent (no metric label distinguishes it from a successful Withdraw-only allow).

The most likely real-world trigger is **ABI drift between the deployed pool contract and this service's SDK pin** -- e.g., you upgrade the pool contract before bumping `@starkware-libs/starknet-privacy-sdk` and redeploying the sidecar. During that window, every Deposit transaction is allowed without screening.

Mitigations:
- Gate pool-contract upgrades on a coordinated SDK release + sidecar redeploy.
- Add a CI check that decodes a known-good Deposit fixture against the SDK on every deploy.
- If your threat model warrants it, change `hasDepositAction`'s `catch` branch to bias toward block.

### `user_addr` is the only screened address

Only `user_addr` (`inner_calldata[0]`) is screened. The service does **not** screen:

- `sender_address` (the signing account)
- `token` addresses inside Deposit actions
- Withdrawal recipient addresses
- External contract addresses targeted by other calls
- Any other address that happens to appear in calldata

The compliance correctness of this service rests on the assumption that `user_addr` is the actual fund source -- i.e., the contract enforces that deposits debit `user_addr`'s balance and not some other account. If that invariant ever breaks (e.g., a refactor lets `sender_address` deposit on behalf of `user_addr` without `user_addr`'s consent, or vice versa), the screening gate becomes ineffective without any error or alert.

Treat the contract's deposit semantics as part of this gate's TCB; review them whenever the pool contract changes.

### Unauthenticated listener

The HTTP listener accepts any well-formed JSON-RPC `starknet_checkTransaction` request from any source that can reach it; there is no API key, mTLS, or network ACL enforced at the application level. Combined with the default bind to all interfaces (`HOST=0.0.0.0`), if the sidecar is exposed beyond the prover Pod's network namespace -- by accident (a Service, NodePort, or Ingress added later) or by a Pod-network misconfiguration -- anyone with reachability gets:

- A free **screening oracle**: probe arbitrary addresses against Elliptic's blocklist by submitting synthetic deposit calldata, learning sanctions status without any API key of their own.
- A way to **burn your partner-secret quota** at elliptic-proxy until rate-limited or blocked, denying screening to legitimate deposits.

Mitigations:
- **Strict same-Pod**: deploy as an in-pod sidecar **and** set `HOST=127.0.0.1` so the listener binds to loopback only. Co-location alone is not the security boundary -- with the default `HOST=0.0.0.0`, the listener is reachable from any Pod that can route to this Pod's IP, which is most of the cluster absent a NetworkPolicy. The prover reaches the sidecar on `localhost:8080`; no Kubernetes Service is needed.
- **Cross-Pod (only if same-Pod isn't viable)**: keep `HOST=0.0.0.0` and rely on a NetworkPolicy that allows ingress only from the prover Pod's labels (and the approved Prometheus scraper). The NetworkPolicy is the real access-control boundary; this service has no application-level authentication. Optionally enable server-side TLS via `TLS_CERT_PATH`/`TLS_KEY_PATH` to encrypt traffic, but note that this does *not* authenticate the client -- the HTTPS server is configured with `cert`/`key` only, not `requestCert`/`ca`. For real client authentication, put a service mesh (Istio, Linkerd, etc.) or proxy in front of the sidecar that enforces mTLS.

Do **not** rely on Kubernetes ClusterIP being "internal-only" as a security boundary against on-cluster adversaries -- anyone with an in-cluster Pod can hit a ClusterIP Service.

### Fail-open layering

There are two fail-open knobs, two layers. Both default to **fail-closed**.

| Layer | Knob (env / value) | Default | Triggers when... |
|---|---|---|---|
| Sidecar -> elliptic-proxy -> Elliptic | `SCREENING_FAIL_OPEN` (env on this service) | `false` (block) | The proxy/Elliptic is unreachable, times out, or returns malformed data after all retries from this service. |
| Prover -> sidecar | `blocking_check_fail_open` (in prover's `config.json`) | `false` (block) | This service itself is unreachable from the prover, OR returns any non-`10000` error (network failure, RPC-validation rejection, exception). |

Layered semantics: a proxy outage trips knob #1; a sidecar outage trips knob #2. Both knobs need to be set to `true` to fail-open on screening outages end-to-end. The prover's knob is the only one that protects against this service being entirely unreachable.

### Silent pass-through

With no `SCREENING_URL` env var, this service runs as a no-op that always returns `{ allowed: true }`. Intended only for local development. **A misconfigured deployment that omits `SCREENING_URL` does not crash and does not log a warning** -- it serves a healthy `/health` and silently allows everything.

Verify a real deployment is screening by sending a known-sanctioned test address through the prover and confirming a `10000` response, or by checking `proof_interceptor_screening_results_total` is non-zero on `/metrics`.

A future code change should either bind explicit `SCREENING_DISABLED=true` for local pass-through, or refuse to start without an explicit toggle. Until then, treat the missing-URL pass-through as a deployment hazard.
