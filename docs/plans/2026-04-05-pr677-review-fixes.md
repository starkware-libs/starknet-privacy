# PR #677 Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Address all 7 Copilot review comments on `ittay/elliptic-proxy-screening` — error handling, LRU eviction, doc alignment, and test hygiene.

**Architecture:** All changes are on branch `ittay/elliptic-proxy-screening`. Items 1 & 7 port error-handling patterns from the scoring branch but without scoring/cache imports. Item 2 adds LRU eviction to the rate limiter. Items 3-4 align docs with code. Items 5-6 fix test cleanup.

**Tech Stack:** TypeScript, Vitest, Node.js

**Branch:** `ittay/elliptic-proxy-screening` (checkout before starting)

---

### Task 1: Wrap `forward()` in try/catch (comment #1)

**Files:**
- Modify: `elliptic-proxy/src/handler.ts` (~line 113)

**Context:** On this branch, the `forward()` call is bare — no try/catch. The scoring branch added one, but that version also imports scoring/cache. We just need the error handling.

**Step 1: Wrap the forward call**

Replace the bare `await forward(...)` block (lines 113-120) with:

```typescript
    let result: ForwardResponse;
    try {
      result = await forward({
        ellipticUrl: config.elliptic.url,
        ellipticKey: config.elliptic.key,
        ellipticSecret: config.elliptic.secret,
        ellipticTimeoutMs: config.elliptic.timeoutMs,
        address,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          error: "upstream_request_failed",
          message: error instanceof Error ? error.message : String(error),
        })
      );
      sendResponse(503, JSON.stringify({ error: "service unavailable" }), {
        partner: partnerName,
        reason: "upstream_request_failed",
      });
      return;
    }
```

Keep the existing hardcoded `blocked = true` and response below it unchanged.

---

### Task 2: Return 502 for non-2xx Elliptic responses (comment #7)

**Files:**
- Modify: `elliptic-proxy/src/handler.ts` (after the try/catch from Task 1, before the hardcoded verdict)

**Step 1: Add non-2xx guard**

Insert between the try/catch and the `const blocked = true` line:

```typescript
    if (result.status < 200 || result.status >= 300) {
      console.error(
        JSON.stringify({
          error: "upstream_error",
          ellipticStatus: result.status,
        })
      );
      sendResponse(502, JSON.stringify({ error: "upstream error" }), {
        partner: partnerName,
        reason: "upstream_non_2xx",
        ellipticStatus: result.status,
      });
      return;
    }
```

---

### Task 3: Add handler tests for error paths (comments #1 & #7)

**Files:**
- Modify: `elliptic-proxy/tests/handler.test.ts`

**Step 1: Add test for forward() network error**

```typescript
  it("returns 503 when forward throws a network error", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    mockForward.mockRejectedValue(new Error("fetch failed"));

    const handler = createHandler(configLoader, mockForward);
    const req = makeRequest();
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "service unavailable" });
  });
```

**Step 2: Add test for non-2xx Elliptic response**

```typescript
  it("returns 502 when Elliptic returns non-2xx", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    mockForward.mockResolvedValue({
      status: 500,
      body: '{"error":"internal"}',
      durationMs: 10,
    });

    const handler = createHandler(configLoader, mockForward);
    const req = makeRequest();
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "upstream error" });
  });
```

**Step 3: Run tests**

```bash
cd elliptic-proxy && npm test
```

Expected: all tests pass.

---

### Task 4: LRU eviction for rate limiter (comment #2)

**Files:**
- Modify: `elliptic-proxy/src/rate-limit.ts`

**Context:** Currently `MAX_PARTNERS = 20` blocks new partners permanently once 20 distinct names have been seen, because expired windows are never evicted. Fix: when a new partner arrives and the map is full, prune expired windows first. If still full, evict the least-recently-used entry.

**Step 1: Rewrite rate-limit.ts**

```typescript
// src/rate-limit.ts

// Simple fixed-window rate limiter: counts requests per partner within a 1-minute window.
interface Window {
  count: number;
  windowStart: number;
  lastAccess: number;
}

const WINDOW_MS = 60_000;
const MAX_PARTNERS = 20;

export class RateLimiter {
  private windows = new Map<string, Window>();

  check(partnerName: string, limitPerMinute: number): boolean {
    const now = Date.now();
    const window = this.windows.get(partnerName);

    if (!window || now - window.windowStart >= WINDOW_MS) {
      if (!window && this.windows.size >= MAX_PARTNERS) {
        this.evict(now);
        if (this.windows.size >= MAX_PARTNERS) {
          return false;
        }
      }
      this.windows.set(partnerName, { count: 1, windowStart: now, lastAccess: now });
      return true;
    }

    if (window.count >= limitPerMinute) {
      return false;
    }

    window.count++;
    window.lastAccess = now;
    return true;
  }

  private evict(now: number): void {
    // First pass: remove expired windows
    for (const [name, window] of this.windows) {
      if (now - window.windowStart >= WINDOW_MS) {
        this.windows.delete(name);
      }
    }

    // If still full, evict the least-recently-used entry
    if (this.windows.size >= MAX_PARTNERS) {
      let oldestName: string | null = null;
      let oldestAccess = Infinity;
      for (const [name, window] of this.windows) {
        if (window.lastAccess < oldestAccess) {
          oldestAccess = window.lastAccess;
          oldestName = name;
        }
      }
      if (oldestName) {
        this.windows.delete(oldestName);
      }
    }
  }
}
```

---

### Task 5: Add rate limiter eviction tests (comment #2)

**Files:**
- Modify: `elliptic-proxy/tests/rate-limit.test.ts`

**Step 1: Add eviction tests after the existing tests**

```typescript
  it("evicts expired windows when MAX_PARTNERS is reached", () => {
    const limiter = new RateLimiter();
    // Fill up 20 partners
    for (let partnerIndex = 0; partnerIndex < 20; partnerIndex++) {
      expect(limiter.check(`partner-${partnerIndex}`, 100)).toBe(true);
    }

    // Advance past window expiry
    vi.advanceTimersByTime(60_000);

    // New partner should succeed — expired windows get pruned
    expect(limiter.check("partner-new", 100)).toBe(true);
  });

  it("evicts LRU partner when MAX_PARTNERS reached and none expired", () => {
    const limiter = new RateLimiter();
    // Fill up 20 partners, each 1ms apart so LRU is deterministic
    for (let partnerIndex = 0; partnerIndex < 20; partnerIndex++) {
      limiter.check(`partner-${partnerIndex}`, 100);
      vi.advanceTimersByTime(1);
    }

    // New partner should succeed — LRU (partner-0) gets evicted
    expect(limiter.check("partner-new", 100)).toBe(true);

    // partner-0 was evicted, so a fresh check creates a new window
    expect(limiter.check("partner-0", 100)).toBe(true);
  });
```

**Step 2: Add afterEach for timer cleanup (comment #5)**

Add after the `beforeEach`:

```typescript
  afterEach(() => {
    vi.useRealTimers();
  });
```

Import `afterEach` from vitest (add to the existing import).

**Step 3: Run tests**

```bash
cd elliptic-proxy && npm test
```

Expected: all tests pass.

---

### Task 6: Fix elliptic.test.ts mock cleanup (comment #6)

**Files:**
- Modify: `elliptic-proxy/tests/elliptic.test.ts`

**Step 1: Move stub to beforeEach/afterEach**

Replace the top of the file:

```typescript
// tests/elliptic.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { forwardToElliptic } from "../src/elliptic.js";

const mockFetch = vi.fn();

describe("forwardToElliptic", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
```

Remove the old module-scope `vi.stubGlobal("fetch", mockFetch);` line.

**Step 2: Run tests**

```bash
cd elliptic-proxy && npm test
```

Expected: all tests pass.

---

### Task 7: Update README config schema (comment #3)

**Files:**
- Modify: `elliptic-proxy/README.md`

**Step 1: Update the JSON example**

Replace `"cacheTtlSeconds": 300` with:

```json
  "configCacheTtlSeconds": 300,
  "blockedCacheTtlSeconds": 3600,
```

**Step 2: Update the field table**

Replace the `cacheTtlSeconds` row with two rows:

| Field | Description |
|-------|-------------|
| `configCacheTtlSeconds` | How long to cache the config before re-reading from Secret Manager (seconds) |
| `blockedCacheTtlSeconds` | How long to cache blocked address verdicts (seconds) |

---

### Task 8: Align design.md (comment #4)

**Files:**
- Modify: `elliptic-proxy/design.md`

**Step 1: Fix the overview paragraph (line 5-9)**

Replace:

> A GCP Cloud Function (TypeScript/Node.js) that acts as a transparent proxy to
> Elliptic's API. Third-party partners call it exactly as they would call Elliptic
> (same headers, same HMAC signing). The proxy verifies the partner's signature,
> re-signs with the real Elliptic credentials, and forwards the request. The
> response is returned as-is.

With:

> A GCP Cloud Function (TypeScript/Node.js) that screens blockchain addresses via
> Elliptic's API. Third-party partners send an address; the proxy authenticates
> the request, re-signs with real Elliptic credentials, forwards to Elliptic,
> scores the response, and returns a `{ blocked: true/false }` verdict.

**Step 2: Update the config JSON example**

Replace `"cacheTtlSeconds": 300` with:

```json
  "configCacheTtlSeconds": 300,
  "blockedCacheTtlSeconds": 3600,
```

**Step 3: Update the config fields table**

Replace the `cacheTtlSeconds` row with the same two rows as in Task 7.

---

### Task 9: Final verification

**Step 1: Run full test suite**

```bash
cd elliptic-proxy && npm test
```

**Step 2: Run lint**

```bash
cd elliptic-proxy && npm run lint
```

Expected: all pass, zero warnings.
