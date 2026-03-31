# Observability: Structured Log Enrichment for Grafana

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enrich structured JSON logs in both elliptic-proxy and prover-proxy so that Cloud Logging log-based metrics (or direct Grafana Cloud Logging queries) provide full dashboard coverage without any OTel SDK.

**Architecture:** No new dependencies. All changes are additive fields in existing `console.log`/`console.error` JSON output. `scoreResponse` returns a richer result object instead of a boolean. `forwardToElliptic` returns timing. Handler and proxy log additional fields.

**Tech Stack:** TypeScript, vitest, Google Cloud Logging (via structured stdout/stderr)

**Branch:** New stacked branch `ittay/observability-logs` on top of `ittay/e2e-screening`

---

## Task 1: Enrich `scoreResponse` return type (elliptic-proxy)

**Files:**
- Modify: `elliptic-proxy/src/scoring.ts`
- Test: `elliptic-proxy/tests/scoring.test.ts`

**Step 1: Define the new return type and update existing tests**

Change `scoreResponse` signature from `boolean` to `ScoringResult`:

```ts
export interface ScoringResult {
  blocked: boolean;
  /** Why the decision was made: "clean", "malformed_json", "incomplete", "rule_triggered", "unknown_rule" */
  reason: "clean" | "malformed_json" | "incomplete" | "rule_triggered" | "unknown_rule";
  /** Rule IDs that contributed to the block decision (empty if not blocked) */
  triggeringRuleIds: string[];
}
```

Update `scoreResponse` to return `ScoringResult` instead of `boolean`:
- Malformed JSON: `{ blocked: true, reason: "malformed_json", triggeringRuleIds: [] }`
- `process_status !== "complete"`: `{ blocked: false, reason: "incomplete", triggeringRuleIds: [] }`
- No triggers fire: `{ blocked: false, reason: "clean", triggeringRuleIds: [] }`
- Triggers fire from known rules: `{ blocked: true, reason: "rule_triggered", triggeringRuleIds: [...] }`
- Triggers fire from unknown rules: `{ blocked: true, reason: "unknown_rule", triggeringRuleIds: [...] }`

`filterAndBuildTriggers` needs to track the `rule_id` per trigger. Change the `Trigger` interface:

```ts
interface Trigger {
  ruleId: string;
  percentage: number;
  riskScore: number;
}
```

And in `filterAndBuildTriggers`, push `ruleId: evaluation.rule_id` into each trigger.

Then in `scoreResponse`, collect the rule IDs from triggers that exceed `ALLOWED_RISK_EXPOSURE`:

```ts
const firedTriggers = triggers.filter(
  (trigger) => (trigger.riskScore ?? trigger.percentage) > ALLOWED_RISK_EXPOSURE
);

if (firedTriggers.length === 0) {
  return { blocked: false, reason: "clean", triggeringRuleIds: [] };
}

const triggeringRuleIds = [...new Set(firedTriggers.map((t) => t.ruleId))];
const hasUnknownRule = triggeringRuleIds.some((id) => !(id in RULES));
return {
  blocked: true,
  reason: hasUnknownRule ? "unknown_rule" : "rule_triggered",
  triggeringRuleIds,
};
```

**Step 2: Update all scoring tests**

Every test that currently does `expect(scoreResponse(...)).toBe(true/false)` changes to:
- `expect(scoreResponse(...).blocked).toBe(true/false)` for existing assertions
- Add `.reason` and `.triggeringRuleIds` assertions for key cases

Add new tests:
- `scoreResponse` on blocked ILLICIT returns `reason: "rule_triggered"` and `triggeringRuleIds` containing the ILLICIT UUID
- `scoreResponse` on blocked unknown rule returns `reason: "unknown_rule"`
- `scoreResponse` on malformed JSON returns `reason: "malformed_json"`
- `scoreResponse` on incomplete returns `reason: "incomplete"`

**Step 3: Run tests**

Run: `cd elliptic-proxy && npx vitest run tests/scoring.test.ts`
Expected: ALL PASS

**Step 4: Commit**

```
feat(elliptic-proxy): enrich scoreResponse with reason and triggering rule IDs
```

---

## Task 2: Add `durationMs` to `ForwardResponse` (elliptic-proxy)

**Files:**
- Modify: `elliptic-proxy/src/elliptic.ts`
- Test: `elliptic-proxy/tests/elliptic.test.ts` (if it tests the response shape)

**Step 1: Add timing to `forwardToElliptic`**

Add `durationMs` to `ForwardResponse`:

```ts
export interface ForwardResponse {
  status: number;
  body: string;
  durationMs: number;
}
```

Wrap the fetch call:

```ts
const startTime = Date.now();
const response = await fetch(...);
const body = await response.text();
return { status: response.status, body, durationMs: Date.now() - startTime };
```

**Step 2: Update `Forwarder` type in handler.ts if needed**

The `Forwarder` type in `handler.ts` uses `ForwardResponse` from `elliptic.ts`, so it picks up the new field automatically. No change needed.

**Step 3: Run tests**

Run: `cd elliptic-proxy && npx vitest run`
Expected: ALL PASS (existing tests don't assert on the response shape from `forwardToElliptic` — only the mock `forward` in handler tests matters, and those return whatever they want)

**Step 4: Commit**

```
feat(elliptic-proxy): add durationMs to Elliptic API forward response
```

---

## Task 3: Enrich handler logs (elliptic-proxy)

**Files:**
- Modify: `elliptic-proxy/src/handler.ts`
- Test: `elliptic-proxy/tests/handler.test.ts`

**Step 1: Use `ScoringResult` and add fields to success log**

Import `ScoringResult` and change:

```ts
// Before:
const blocked = scoreResponse(result.body);

// After:
const scoringResult = scoreResponse(result.body);
const blocked = scoringResult.blocked;
```

Add fields to the success `sendResponse` call:

```ts
sendResponse(200, JSON.stringify({ blocked }), {
  partner: partnerName,
  ellipticStatus: result.status,
  ellipticLatencyMs: result.durationMs,
  result: blocked ? "blocked" : "allowed",
  scoringReason: scoringResult.reason,
  triggeringRuleIds: scoringResult.triggeringRuleIds.length > 0
    ? scoringResult.triggeringRuleIds
    : undefined,
  cacheSize: blockedCache.size,
});
```

Add `result: "cached"` to the cache-hit log:

```ts
sendResponse(200, JSON.stringify({ blocked: true }), {
  partner: partnerName,
  result: "cached",
  cached: true,
  cacheSize: blockedCache.size,
});
```

Categorize upstream errors — change the catch block and non-2xx block:

```ts
// Network error (catch block):
sendResponse(503, JSON.stringify({ error: "service unavailable" }), {
  partner: partnerName,
  result: "error",
  errorType: "network",
});

// Non-2xx:
sendResponse(502, JSON.stringify({ error: "upstream error" }), {
  partner: partnerName,
  result: "error",
  errorType: "upstream_non_2xx",
  ellipticStatus: result.status,
});
```

Also remove `address` from the `upstream_error` console.error (line 169) — same privacy concern we fixed in prover-proxy:

```ts
// Before:
console.error(JSON.stringify({ error: "upstream_error", ellipticStatus: result.status, address }));

// After:
console.error(JSON.stringify({ error: "upstream_error", ellipticStatus: result.status }));
```

**Step 2: Update handler tests**

The mock `forward` in handler tests returns `{ status, body }` — add `durationMs: 5` to all mock return values.

For the "blocked" test, add assertion that the `console.log` call includes `result: "blocked"` and `triggeringRuleIds`.

For the "clean" test, assert `result: "allowed"` and `scoringReason: "clean"`.

For the "cached" test, assert the second call logs `result: "cached"`.

Use `vi.spyOn(console, "log")` to capture and assert log fields.

**Step 3: Run tests**

Run: `cd elliptic-proxy && npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```
feat(elliptic-proxy): enrich structured logs for Grafana observability
```

---

## Task 4: Enrich prover-proxy logs

**Files:**
- Modify: `prover-proxy/src/proxy.ts`
- Modify: `prover-proxy/src/screening-interceptor.ts`
- Test: `prover-proxy/tests/proxy.test.ts`
- Test: `prover-proxy/tests/screening-interceptor.test.ts`

**Step 1: Add structured logging to proxy request lifecycle**

The proxy currently has no per-request structured log on the happy path. Add one. At the start of the handler, capture `startTime`. At each exit point, log a structured JSON line.

Create a helper inside `createProxyHandler`:

```ts
function logRequest(fields: object) {
  console.log(JSON.stringify({
    method: req.method,
    url: req.url,
    ...fields,
    latencyMs: Date.now() - startTime,
  }));
}
```

Add `const startTime = Date.now();` at the top of the handler (after the health check early return).

Add `logRequest(...)` calls at each exit point:

- RPC validation error: `{ rpcAction: "error" }`
- Interceptor rejection: `{ rpcAction: "forward_with_interceptors", interceptorVerdict: "stop" }`
- Upstream error (interceptor path): `{ rpcAction: "forward_with_interceptors", interceptorVerdict: "continue", upstreamStatus: 502 }`
- Upstream success (interceptor path): `{ rpcAction: "forward_with_interceptors", interceptorVerdict: "continue", upstreamStatus: response.status }`
- Forward-as-is success/error: `{ rpcAction: "forward_as_is", upstreamStatus: response.status }`
- Non-JSON passthrough: `{ rpcAction: "passthrough", upstreamStatus: response.status }`
- 413: `{ error: "payload_too_large" }`

**Step 2: Add attempt count to screening interceptor logs**

In `screenAddress`, track the attempt count and include it in the failure log:

```ts
// Before:
console.error(JSON.stringify({
  error: "screening_failed",
  message: lastError?.message,
  failOpen: this.config.failOpen,
}));

// After:
console.error(JSON.stringify({
  error: "screening_failed",
  message: lastError?.message,
  failOpen: this.config.failOpen,
  attempts: attempt,
}));
```

To make `attempt` accessible after the loop, declare `let finalAttempt = 0;` before the loop and set `finalAttempt = attempt` at the start of each iteration.

Also add a structured log for successful screening calls (after `return blocked ? "blocked" : "allowed"`). To do this, refactor slightly — add timing around `callEllipticProxy`:

```ts
const callStart = Date.now();
const blocked = await this.callEllipticProxy(address, perCallTimeout);
console.log(JSON.stringify({
  screening: "complete",
  result: blocked ? "blocked" : "allowed",
  attempts: attempt + 1,
  screeningLatencyMs: Date.now() - callStart,
}));
return blocked ? "blocked" : "allowed";
```

**Step 3: Update tests**

Add `vi.spyOn(console, "log")` / `vi.spyOn(console, "error")` where needed to prevent test output noise and to assert on key log fields.

In `proxy.test.ts`, verify that successful requests log `rpcAction` and `latencyMs`.

In `screening-interceptor.test.ts`, verify the retry test logs `attempts`.

**Step 4: Run tests**

Run: `cd prover-proxy && npx vitest run`
Expected: ALL PASS

**Step 5: Commit**

```
feat(prover-proxy): structured request logging for observability
```

---

## Task 5: Update e2e test and final verification

**Files:**
- Modify: `prover-proxy/tests/e2e.test.ts` (only if the changes break it — the e2e test doesn't assert on log output, only on HTTP responses, so it likely needs no changes)

**Step 1: Run e2e tests**

Run: `cd prover-proxy && npx vitest run tests/e2e.test.ts`
Expected: ALL PASS

**Step 2: Run full test suites for both projects**

Run: `cd elliptic-proxy && npx vitest run`
Expected: ALL PASS

Run: `cd prover-proxy && npx vitest run`
Expected: ALL PASS

**Step 3: Run linting**

Run: `cd elliptic-proxy && npx prettier --check src/ tests/ && npx eslint src/ tests/`
Expected: CLEAN

Run: `cd prover-proxy && npx prettier --check src/ tests/ && npx eslint src/ tests/`
Expected: CLEAN

**Step 4: Create the stacked branch**

All commits from Tasks 1-4 should be on `ittay/observability-logs`, stacked on top of `ittay/e2e-screening`.

---

## Log Field Summary

### elliptic-proxy success log (per request)

| Field | Type | Values | Source |
|---|---|---|---|
| `method` | string | POST | existing |
| `path` | string | /screen | existing |
| `status` | number | 200, 400, 401, 413, 429, 502, 503 | existing |
| `latencyMs` | number | total request time | existing |
| `partner` | string | partner name | existing |
| `result` | string | allowed, blocked, cached, error | **new** |
| `ellipticStatus` | number | Elliptic HTTP status | existing (on success path) |
| `ellipticLatencyMs` | number | Elliptic API call time only | **new** |
| `scoringReason` | string | clean, malformed_json, incomplete, rule_triggered, unknown_rule | **new** |
| `triggeringRuleIds` | string[] | Elliptic rule UUIDs | **new** (only when blocked) |
| `cacheSize` | number | blocked cache entry count | **new** |
| `cached` | boolean | true | existing (only on cache hits) |
| `errorType` | string | network, upstream_non_2xx | **new** (only on errors) |
| `reason` | string | auth failure reasons | existing (only on 401) |

### prover-proxy request log (per request)

| Field | Type | Values | Source |
|---|---|---|---|
| `method` | string | POST, GET | **new** |
| `url` | string | request path | **new** |
| `rpcAction` | string | forward_as_is, forward_with_interceptors, error, passthrough | **new** |
| `interceptorVerdict` | string | continue, stop | **new** (only for forward_with_interceptors) |
| `upstreamStatus` | number | HTTP status | **new** |
| `latencyMs` | number | total request time | **new** |

### prover-proxy screening log (per screening call)

| Field | Type | Values | Source |
|---|---|---|---|
| `screening` | string | "complete" | **new** |
| `result` | string | allowed, blocked | **new** |
| `attempts` | number | attempt count | **new** |
| `screeningLatencyMs` | number | screening call time | **new** |

### prover-proxy screening error log (on exhausted retries)

| Field | Type | Values | Source |
|---|---|---|---|
| `error` | string | "screening_failed" | existing |
| `message` | string | last error message | existing |
| `failOpen` | boolean | config value | existing |
| `attempts` | number | total attempts made | **new** |
