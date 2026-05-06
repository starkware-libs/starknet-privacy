# Screening flow

A single client `starknet_proveTransaction` produces one screening round-trip through this service. The numbered steps trace what happens inside the sidecar, from receiving the prover's RPC to building the response.

For the high-level overview and the prover/proxy/Elliptic boundary, see the top-level [`README.md`](../README.md).

## 1. Receive the prover's screening RPC

The prover (with `blocking_check_url` configured) sends a `starknet_checkTransaction` JSON-RPC POST to `/`. Body shape mirrors `starknet_proveTransaction` exactly: `block_id` plus the full `RpcTransaction`. See `src/rpc.ts`.

## 2. Validate the JSON-RPC envelope

- `jsonrpc` must be `"2.0"`, `id` must be present, `method` must be `starknet_checkTransaction`. Anything else returns a JSON-RPC error:
  - Body that fails `JSON.parse` (malformed JSON) -> `-32600` with message `"Parse error"`.
  - Body that parses to a non-object (array, `null`, primitive) or is missing `jsonrpc`/`method`/`id` -> `-32600` with message `"Invalid Request"`.
  - Method other than `starknet_checkTransaction` -> `-32601` `"Method not found"`.

  All three shape errors share code `-32600`/`-32601`; the message string is what distinguishes parse failure from shape failure inside the `-32600` family.
- The transaction must be `INVOKE` v3. Other types return `61` ("Unsupported tx version") to match the real prover's behavior, so the prover can interpret the response identically.
- `block_id == "pending"` returns `24` ("Block not found"), again matching the prover.
- Rejected envelopes never reach the screening logic. The error response is sent back to the prover, which interprets a non-`10000` error as **inconclusive** and falls back to its own fail-open policy (see [`security-boundaries.md`](security-boundaries.md#fail-open-layering)).

## 3. Run the interceptor pipeline

`runInterceptors` (`src/interceptor.ts`) executes all configured interceptors **in parallel** with first-block-wins semantics: the first interceptor to return `block` short-circuits the round, otherwise the response is `allow` only if every interceptor returned `allow`. Today there is one configured interceptor (`ScreeningInterceptor`); the pipeline is plumbing for adding more without changing the proxy.

## 4. Pool-call gate

`isSinglePoolCall` in `src/screening-interceptor.ts` checks the calldata layout:

```
calldata[0] = "0x1"           # call_count must be exactly 1
calldata[1] = poolAddress     # contract_address must match SCREENING_POOL_ADDRESS
calldata[2] = selector
calldata[3] = inner_calldata_len
calldata[4..] = inner calldata
```

Multi-call INVOKEs and INVOKEs targeting other contracts are *not* pool transactions even if a sub-call hits the pool. Whether they pass through unscreened or are blocked outright is controlled by `SCREENING_BLOCK_NON_POOL_TX`.

The gate uses literal-string comparison and is sensitive to non-canonical felt encodings (`"0x01"`, `"0X1"`) and to address case. See [`security-boundaries.md`](security-boundaries.md#non-canonical-felt-encodings).

## 5. Deposit detection

For single pool calls, the inner calldata is `[user_addr, user_private_key, ...action_span]`. The action span is decoded against the on-chain ABI (`PrivacyPoolABI` from `@starkware-libs/starknet-privacy-sdk`) and inspected for any action whose `activeVariant() === "Deposit"`. Withdraw-only transactions and malformed action spans short-circuit to `allow` -- withdraws don't introduce new funds into the pool, so they don't need address screening.

ABI drift (pool contract upgraded but SDK pin not bumped) makes every Deposit during the mismatch window fall into the malformed-action-span branch and silently allow. See [`security-boundaries.md`](security-boundaries.md#abi-drift).

## 6. Address extraction

The depositor address is the `user_addr` slot in the inner calldata (`inner_calldata[0]`), normalized by stripping leading zeros from the hex (so `0x00004a1b2c` -> `0x4a1b2c`, and an all-zero address becomes `0x0`). This service **preserves case** when sending the address to elliptic-proxy; elliptic-proxy itself lowercases the address before forwarding to Elliptic and before any internal allowlist/blocklist checks, so the value Elliptic actually sees is always lowercase. The calldata layout has only one `user_addr` regardless of how many actions appear in the action span, so a single transaction yields **one** address to screen, even if it bundles multiple Deposit actions. Withdraw-only transactions short-circuit earlier in step 5 and yield zero addresses.

`user_addr` is the only address this service screens -- and that's a load-bearing trust assumption. See [`security-boundaries.md`](security-boundaries.md#user-addr-is-the-only-screened-address) for what is *not* screened and the contract-side invariants this gate depends on.

## 7. Per-address Elliptic call

For each extracted address, `screenAddress` builds a request to `elliptic-proxy`:

- HTTP POST `${SCREENING_URL}/screen` with body `{"address": "0x..."}`.
- Headers carry partner identity and HMAC authentication:
  - `x-access-key: <SCREENING_PARTNER_NAME>`
  - `x-access-timestamp: <unix-ms>`
  - `x-access-sign: HMAC-SHA256(base64-decoded SCREENING_PARTNER_SECRET, timestamp || "POST" || "/screen" || body) -> base64`
- Per-call timeout: `SCREENING_TIMEOUT_MS` (default 10s), enforced via `AbortSignal.timeout`.

The proxy itself fans out to Elliptic's AML API and caches the verdict; on cache hits the response is sub-millisecond.

A self-contained Node.js script that constructs the same request for credential verification is in [`api.md`](api.md#hmac-signing-snippet).

## 8. Retry / overall budget

On transient failure (network error, non-2xx, malformed response) the call is retried up to `SCREENING_MAX_RETRIES` times (default 2) with exponential backoff (1s, 2s, 4s, capped at 5s). All retries must complete inside `SCREENING_TOTAL_TIMEOUT_MS` (default 10s); the deadline is shared across attempts so backoff sleeps don't blow the budget.

## 9. Verdict resolution

| Per-address Elliptic outcome | Interceptor verdict |
|---|---|
| `blocked: true` | `block` with reason `address screening: <addr> blocked` |
| `blocked: false` | continue to next address |
| All addresses returned `blocked: false` | `allow` |
| All retries exhausted, `SCREENING_FAIL_OPEN=false` | `block` with reason `screening unavailable for <addr>`; `proof_interceptor_screening_results_total{result="unavailable"}` increments |
| All retries exhausted, `SCREENING_FAIL_OPEN=true` | `allow`; `proof_interceptor_screening_results_total{result="allowed"}` increments -- *indistinguishable in metrics from a real allow*. The unavailability is logged (`{"error":"screening_failed", ...}`) but not surfaced as a separate metric label. Alert on `screening_failed` log lines if you need visibility into fail-open allowances. |

The default is **fail-closed**: if Elliptic can't be reached or returns inconclusively, the deposit is rejected. Override `SCREENING_FAIL_OPEN=true` only for testnet or when there's a higher-level gate elsewhere in the pipeline.

## 10. Build the JSON-RPC response

- `allow` -> `{ "jsonrpc": "2.0", "id": <req-id>, "result": { "allowed": true } }`, HTTP 200.
- `block` -> standard JSON-RPC error envelope with `code: 10000`, `message: "Transaction rejected"`, `data: <reason>`, HTTP 200 (the JSON-RPC convention is to embed errors in 200 responses).

Concrete example bodies for each response shape are in [`api.md`](api.md#response-shapes).

## 11. The prover combines verdicts

Back at the prover:

- `allowed: true` -> return the proof to the client.
- `code: 10000` -> return error 10000 to the client; the proof, even if computed, is discarded.
- Network error, timeout, or any non-`10000` error -> "inconclusive". The prover then falls back to its own `blocking_check_fail_open` setting (configured in the prover's `config.json`). This is a separate fail-open knob from the sidecar's own; together they form a layered policy described in [`security-boundaries.md`](security-boundaries.md#fail-open-layering).
