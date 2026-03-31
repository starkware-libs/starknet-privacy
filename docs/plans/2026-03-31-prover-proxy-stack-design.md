# Prover Proxy Stack — Overarching Design

## Architecture

```
Client ──► Prover Proxy (TS, long-running) ──► Upstream Prover
                │                                    │
                │ interceptors (parallel)             │
                │   ├─ screening interceptor ────► Elliptic Proxy (GCP Cloud Function)
                │   ├─ (future: balance check)            │
                │   └─ (future: tx storage)               ▼
                │                                   Elliptic API
                ▼
           Response or RPC error
```

Two independent TypeScript projects, two top-level folders:

| | Elliptic Proxy | Prover Proxy |
|---|---|---|
| **Location** | `elliptic-proxy/` | `prover-proxy/` |
| **Runtime** | GCP Cloud Function | Long-running Node server |
| **Role** | Screening gateway (accept/reject) | JSON-RPC reverse proxy with interceptors |
| **API** | `POST /` → `{ blocked: boolean }` | JSON-RPC (`starknet_proveTransaction`, etc.) |

## Branch Stack

| # | Branch | Scope | Folder |
|---|--------|-------|--------|
| 1 | Elliptic proxy forward | Rewrite elliptic-proxy: auth, signing, forward to Elliptic, return `{ blocked: true }` hardcoded (rule-based scoring deferred) | `elliptic-proxy/` |
| 2 | Reverse proxy skeleton | Bare-bones transparent HTTP reverse proxy with TLS support. No prover awareness. | `prover-proxy/` |
| 3 | Prover RPC support | Add `starknet_proveTransaction` + `starknet_specVersion` JSON-RPC handling, typed transaction parsing | `prover-proxy/` |
| 4 | Interceptor framework | Interceptor interface, parallel execution, verdict collection, RPC error on rejection | `prover-proxy/` |
| 5 | Rule-based scoring | Parse Elliptic response, apply threshold rules (4 categories), in-memory cache of blocked addresses | `elliptic-proxy/` |
| 6 | Screening interceptor | Interceptor that calls elliptic-proxy with API key + HMAC signing, stops on `{ blocked: true }` | `prover-proxy/` |

## Key Design Decisions

- **Elliptic proxy returns `{ blocked: boolean }`**, not raw Elliptic data. Decision logic lives close to the Elliptic domain, not in the prover proxy.
- **Prover proxy is generic first** (branch 2-3), then adds interceptors (branch 4). This keeps each branch small and reviewable.
- **Interceptors run in parallel with each other AND with the upstream forward.** If any returns `Stop`, the client gets an RPC error regardless of upstream result.
- **In-memory cache** for blocked addresses in the elliptic proxy — blocked addresses are cached (they rarely become unblocked), non-blocked addresses are always re-screened (matches starknet-apps behavior).
- **HMAC auth** between prover-proxy and elliptic-proxy reuses the existing partner key scheme.

## Per-Branch Details

### Branch 1: Elliptic Proxy Forward

Rewrite `elliptic-proxy/` as a GCP Cloud Function that:
- Accepts POST requests with partner authentication (HMAC-SHA256 via `x-access-key`, `x-access-sign`, `x-access-timestamp`)
- Validates and rate-limits per partner
- Re-signs the request with our Elliptic API credentials (stored securely, e.g., GCP Secret Manager)
- Forwards to the Elliptic API
- Returns `{ blocked: true }` hardcoded (rule-based scoring comes in branch 5)
- Comment in code: "TODO: replace with rule-based scoring (branch 5)"

### Branch 2: Reverse Proxy Skeleton

Create `prover-proxy/` as a bare-bones transparent reverse proxy:
- Accepts any HTTP request
- Forwards to configurable upstream server
- Returns upstream response to caller
- TLS termination support (cert + key config)
- Health endpoint (`GET /health`)
- Graceful shutdown on SIGTERM/SIGINT
- No JSON-RPC awareness, no prover-specific logic

### Branch 3: Prover RPC Support

Add JSON-RPC layer on top of the reverse proxy:
- Parse JSON-RPC requests
- Handle `starknet_specVersion` (forward and return)
- Handle `starknet_proveTransaction` with typed parsing of `RpcInvokeTransactionV3`
- Forward to upstream prover, return result
- Reject non-INVOKE_V3 transactions with appropriate JSON-RPC error
- Type definitions for transaction, block ID, prove result

### Branch 4: Interceptor Framework

Add pluggable interceptor architecture:
- `TransactionInterceptor` interface: `intercept(transaction) → Verdict`
- `Verdict`: `Continue` or `Stop { reason }`
- On `starknet_proveTransaction`: fire the upstream request first, THEN fire interceptors. JS is single-threaded so even though everything is async, we want the upstream fetch (which involves real I/O setup) to start before interceptor fetches. All run concurrently once fired.
- Collect verdicts after upstream responds
- If any `Stop` → return JSON-RPC error -32001 with reason
- Interceptor panics/errors treated as rejections
- Tests with mock interceptors (allow-all, block-all, slow, panicking)

### Branch 5: Rule-Based Scoring

Replace hardcoded `{ blocked: true }` in elliptic-proxy with actual scoring:
- Parse Elliptic wallet exposure response (`evaluation_detail.source`)
- Apply 4 rule categories with thresholds:
  - ILLICIT_ACTIVITY: block if both counterparty (>0.1%, >$0) AND contribution (>0.1%, >$10) exceeded
  - SANCTIONED_ENTITY: block if either counterparty (>0%, >$0) OR contribution (>0.1%, >$10) exceeded
  - OBFUSCATING: block if either counterparty (>0.1%, >$0) OR contribution (>0.1%, >$10) exceeded
  - DPRK_BYBIT_EXPLOIT: block if either counterparty (>0.00001%, >$0) OR contribution (>0.1%, >$10) exceeded
- Hard block: contribution >= $5000 on ILLICIT_ACTIVITY or SANCTIONED → force block
- In-memory cache: blocked addresses cached (configurable TTL), non-blocked always re-screened
- Return `{ blocked: boolean }`

### Branch 6: Screening Interceptor

Add a concrete interceptor to the prover proxy:
- Extracts sender address from `RpcInvokeTransactionV3`
- Calls elliptic-proxy with HMAC-signed request
- If response is `{ blocked: true }` → `Stop { reason: "address screening failed" }`
- If response is `{ blocked: false }` → `Continue`
- If elliptic-proxy is unreachable → configurable behavior (fail-open or fail-closed)
- Timeout configuration for the screening call
