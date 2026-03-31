# Elliptic Proxy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a GCP Cloud Function that transparently proxies requests to Elliptic's API, swapping partner credentials for real ones.

**Architecture:** A stateless HTTP Cloud Function. Partner keys and config live in GCP Secret Manager (cached in-memory). Each request is authenticated via HMAC, rate-limited, body-filtered, re-signed, and forwarded.

**Tech Stack:** TypeScript, Node.js 20, `@google-cloud/functions-framework`, `@google-cloud/secret-manager`, vitest for testing.

---

### Task 1: Project scaffold

**Files:**
- Create: `elliptic-proxy/package.json`
- Create: `elliptic-proxy/tsconfig.json`

**Step 1: Create package.json**

```json
{
  "name": "@starkware-libs/elliptic-proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "functions-framework --target=ellipticProxy --source=dist/",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest watch",
    "lint": "prettier --check src/ tests/ && eslint src/ tests/ && tsc --noEmit",
    "format": "prettier --write src/ tests/ && eslint --fix src/ tests/"
  },
  "dependencies": {
    "@google-cloud/functions-framework": "^3.4.0",
    "@google-cloud/secret-manager": "^5.6.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.2",
    "@types/node": "^20.14.0",
    "eslint": "^9.39.2",
    "prettier": "^3.7.4",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.51.0",
    "vitest": "^4.0.15"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

**Step 3: Install dependencies**

Run: `cd elliptic-proxy && npm install`

**Step 4: Commit**

```
feat(elliptic-proxy): project scaffold
```

---

### Task 2: Config loading and caching

**Files:**
- Create: `elliptic-proxy/src/config.ts`
- Create: `elliptic-proxy/tests/config.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/config.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigLoader } from "../src/config.js";

const VALID_CONFIG = {
  elliptic: {
    url: "https://api.elliptic.co",
    key: "elliptic-key",
    secret: btoa("elliptic-secret"),
  },
  defaults: {
    rateLimitPerMinute: 100,
    maxBodyBytes: 10240,
    allowedBodyFields: {
      type: ["wallet_exposure"],
    },
  },
  cacheTtlSeconds: 2,
  partners: {
    "partner-a": {
      key: "key-aaa",
      secret: btoa("secret-aaa"),
      rateLimitPerMinute: 200,
    },
    "partner-b": {
      key: "key-bbb",
      secret: btoa("secret-bbb"),
    },
  },
};

describe("ConfigLoader", () => {
  it("loads and parses config from fetcher", async () => {
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(VALID_CONFIG));
    const loader = new ConfigLoader(fetcher);
    const config = await loader.get();
    expect(config.elliptic.key).toBe("elliptic-key");
    expect(config.partners["partner-a"].rateLimitPerMinute).toBe(200);
  });

  it("returns cached config within TTL", async () => {
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(VALID_CONFIG));
    const loader = new ConfigLoader(fetcher);
    await loader.get();
    await loader.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(VALID_CONFIG));
    const loader = new ConfigLoader(fetcher);
    await loader.get();

    vi.useFakeTimers();
    vi.advanceTimersByTime(3000);
    vi.useRealTimers();

    // TTL is 2s, so next get() after 3s should re-fetch
    await loader.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("builds key-to-partner lookup map", async () => {
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(VALID_CONFIG));
    const loader = new ConfigLoader(fetcher);
    const config = await loader.get();
    expect(config.partnerByKey.get("key-aaa")?.name).toBe("partner-a");
    expect(config.partnerByKey.get("key-bbb")?.name).toBe("partner-b");
  });

  it("throws on invalid config JSON", async () => {
    const fetcher = vi.fn().mockResolvedValue("not json");
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd elliptic-proxy && npx vitest run tests/config.test.ts`
Expected: FAIL — module not found

**Step 3: Implement config.ts**

```typescript
// src/config.ts

export interface PartnerConfig {
  key: string;
  secret: string;
  rateLimitPerMinute?: number;
  maxBodyBytes?: number;
  allowedBodyFields?: Record<string, string[]>;
}

export interface RawConfig {
  elliptic: {
    url: string;
    key: string;
    secret: string;
  };
  defaults: {
    rateLimitPerMinute: number;
    maxBodyBytes: number;
    allowedBodyFields?: Record<string, string[]>;
  };
  cacheTtlSeconds: number;
  partners: Record<string, PartnerConfig>;
}

export interface ResolvedPartner {
  name: string;
  key: string;
  secret: string;
  rateLimitPerMinute: number;
  maxBodyBytes: number;
  allowedBodyFields: Record<string, string[]>;
}

export interface ResolvedConfig {
  elliptic: RawConfig["elliptic"];
  defaults: RawConfig["defaults"];
  cacheTtlSeconds: number;
  partners: Record<string, PartnerConfig>;
  partnerByKey: Map<string, ResolvedPartner>;
}

type SecretFetcher = () => Promise<string>;

export class ConfigLoader {
  private cached: ResolvedConfig | null = null;
  private cachedAt = 0;
  private ttlMs = 0;

  constructor(private readonly fetcher: SecretFetcher) {}

  async get(): Promise<ResolvedConfig> {
    if (this.cached && Date.now() - this.cachedAt < this.ttlMs) {
      return this.cached;
    }

    const raw: RawConfig = JSON.parse(await this.fetcher());
    const partnerByKey = new Map<string, ResolvedPartner>();

    for (const [name, partner] of Object.entries(raw.partners)) {
      const merged: ResolvedPartner = {
        name,
        key: partner.key,
        secret: partner.secret,
        rateLimitPerMinute:
          partner.rateLimitPerMinute ?? raw.defaults.rateLimitPerMinute,
        maxBodyBytes: partner.maxBodyBytes ?? raw.defaults.maxBodyBytes,
        allowedBodyFields: {
          ...raw.defaults.allowedBodyFields,
          ...partner.allowedBodyFields,
        },
      };
      partnerByKey.set(partner.key, merged);
    }

    this.cached = {
      elliptic: raw.elliptic,
      defaults: raw.defaults,
      cacheTtlSeconds: raw.cacheTtlSeconds,
      partners: raw.partners,
      partnerByKey,
    };
    this.ttlMs = raw.cacheTtlSeconds * 1000;
    this.cachedAt = Date.now();

    return this.cached;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd elliptic-proxy && npx vitest run tests/config.test.ts`
Expected: PASS (the fake-timer test may need adjustment — fix if needed)

**Step 5: Commit**

```
feat(elliptic-proxy): config loading with TTL cache
```

---

### Task 3: HMAC auth — verification and re-signing

**Files:**
- Create: `elliptic-proxy/src/auth.ts`
- Create: `elliptic-proxy/tests/auth.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/auth.test.ts
import { describe, it, expect } from "vitest";
import { computeHmacSignature, verifySignature } from "../src/auth.js";

const TEST_SECRET = Buffer.from("test-secret").toString("base64");

describe("computeHmacSignature", () => {
  it("produces a deterministic base64 signature", () => {
    const signature = computeHmacSignature(
      TEST_SECRET,
      "1700000000000",
      "POST",
      "/v2/wallet/synchronous",
      '{"type":"wallet_exposure"}'
    );
    expect(typeof signature).toBe("string");
    expect(signature.length).toBeGreaterThan(0);

    // Same inputs → same output
    const again = computeHmacSignature(
      TEST_SECRET,
      "1700000000000",
      "POST",
      "/v2/wallet/synchronous",
      '{"type":"wallet_exposure"}'
    );
    expect(signature).toBe(again);
  });

  it("different secret produces different signature", () => {
    const otherSecret = Buffer.from("other-secret").toString("base64");
    const sig1 = computeHmacSignature(
      TEST_SECRET,
      "1700000000000",
      "POST",
      "/v2/wallet/synchronous",
      "{}"
    );
    const sig2 = computeHmacSignature(
      otherSecret,
      "1700000000000",
      "POST",
      "/v2/wallet/synchronous",
      "{}"
    );
    expect(sig1).not.toBe(sig2);
  });
});

describe("verifySignature", () => {
  it("returns true for valid signature", () => {
    const timestamp = "1700000000000";
    const method = "POST";
    const path = "/v2/wallet/synchronous";
    const body = '{"type":"wallet_exposure"}';
    const signature = computeHmacSignature(
      TEST_SECRET,
      timestamp,
      method,
      path,
      body
    );

    expect(
      verifySignature(TEST_SECRET, signature, timestamp, method, path, body)
    ).toBe(true);
  });

  it("returns false for tampered body", () => {
    const timestamp = "1700000000000";
    const method = "POST";
    const path = "/v2/wallet/synchronous";
    const signature = computeHmacSignature(
      TEST_SECRET,
      timestamp,
      method,
      path,
      '{"type":"wallet_exposure"}'
    );

    expect(
      verifySignature(
        TEST_SECRET,
        signature,
        timestamp,
        method,
        path,
        '{"type":"TAMPERED"}'
      )
    ).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd elliptic-proxy && npx vitest run tests/auth.test.ts`
Expected: FAIL — module not found

**Step 3: Implement auth.ts**

```typescript
// src/auth.ts
import { createHmac, timingSafeEqual } from "crypto";

export function computeHmacSignature(
  secretBase64: string,
  timestamp: string,
  method: string,
  path: string,
  body: string
): string {
  const hmac = createHmac(
    "sha256",
    new Uint8Array(Buffer.from(secretBase64, "base64"))
  );
  hmac.update(timestamp + method + path.toLowerCase() + body);
  return hmac.digest("base64");
}

export function verifySignature(
  secretBase64: string,
  providedSignature: string,
  timestamp: string,
  method: string,
  path: string,
  body: string
): boolean {
  const expected = computeHmacSignature(
    secretBase64,
    timestamp,
    method,
    path,
    body
  );
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(providedSignature);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
```

**Step 4: Run tests to verify they pass**

Run: `cd elliptic-proxy && npx vitest run tests/auth.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(elliptic-proxy): HMAC signature computation and verification
```

---

### Task 4: Rate limiter

**Files:**
- Create: `elliptic-proxy/src/rate-limit.ts`
- Create: `elliptic-proxy/tests/rate-limit.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/rate-limit.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter } from "../src/rate-limit.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("allows requests within limit", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("partner-a", 5)).toBe(true);
    }
  });

  it("rejects requests exceeding limit", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.check("partner-a", 5);
    }
    expect(limiter.check("partner-a", 5)).toBe(false);
  });

  it("resets after one minute", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.check("partner-a", 5);
    }
    expect(limiter.check("partner-a", 5)).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(limiter.check("partner-a", 5)).toBe(true);
  });

  it("tracks partners independently", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.check("partner-a", 5);
    }
    expect(limiter.check("partner-a", 5)).toBe(false);
    expect(limiter.check("partner-b", 5)).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd elliptic-proxy && npx vitest run tests/rate-limit.test.ts`
Expected: FAIL — module not found

**Step 3: Implement rate-limit.ts**

```typescript
// src/rate-limit.ts
interface Window {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000;

export class RateLimiter {
  private windows = new Map<string, Window>();

  check(partnerName: string, limitPerMinute: number): boolean {
    const now = Date.now();
    const window = this.windows.get(partnerName);

    if (!window || now - window.windowStart >= WINDOW_MS) {
      this.windows.set(partnerName, { count: 1, windowStart: now });
      return true;
    }

    if (window.count >= limitPerMinute) {
      return false;
    }

    window.count++;
    return true;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd elliptic-proxy && npx vitest run tests/rate-limit.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(elliptic-proxy): in-memory per-partner rate limiter
```

---

### Task 5: Body field filter

**Files:**
- Create: `elliptic-proxy/src/body-filter.ts`
- Create: `elliptic-proxy/tests/body-filter.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/body-filter.test.ts
import { describe, it, expect } from "vitest";
import { validateBodyFields } from "../src/body-filter.js";

describe("validateBodyFields", () => {
  it("passes when all fields match allowed values", () => {
    const body = { type: "wallet_exposure", subject: { asset: "holistic" } };
    const allowed = {
      type: ["wallet_exposure"],
      "subject.asset": ["holistic"],
    };
    expect(validateBodyFields(body, allowed)).toBe(true);
  });

  it("rejects when a field value is not in allowed list", () => {
    const body = { type: "transaction_exposure" };
    const allowed = { type: ["wallet_exposure"] };
    expect(validateBodyFields(body, allowed)).toBe(false);
  });

  it("passes when body field is missing (no restriction on absence)", () => {
    const body = {};
    const allowed = { type: ["wallet_exposure"] };
    // Field not present in body — no violation
    expect(validateBodyFields(body, allowed)).toBe(true);
  });

  it("handles nested dot-path fields", () => {
    const body = { subject: { asset: "holistic", type: "address" } };
    const allowed = {
      "subject.asset": ["holistic"],
      "subject.type": ["address"],
    };
    expect(validateBodyFields(body, allowed)).toBe(true);
  });

  it("rejects nested field with wrong value", () => {
    const body = { subject: { asset: "bitcoin" } };
    const allowed = { "subject.asset": ["holistic"] };
    expect(validateBodyFields(body, allowed)).toBe(false);
  });

  it("passes with empty allowed fields (no restrictions)", () => {
    const body = { type: "anything" };
    expect(validateBodyFields(body, {})).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd elliptic-proxy && npx vitest run tests/body-filter.test.ts`
Expected: FAIL — module not found

**Step 3: Implement body-filter.ts**

```typescript
// src/body-filter.ts

function getNestedValue(
  object: Record<string, unknown>,
  dotPath: string
): unknown {
  let current: unknown = object;
  for (const segment of dotPath.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function validateBodyFields(
  body: Record<string, unknown>,
  allowedBodyFields: Record<string, string[]>
): boolean {
  for (const [dotPath, allowedValues] of Object.entries(allowedBodyFields)) {
    const actual = getNestedValue(body, dotPath);
    if (actual === undefined) continue;
    if (typeof actual !== "string" || !allowedValues.includes(actual)) {
      return false;
    }
  }
  return true;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd elliptic-proxy && npx vitest run tests/body-filter.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(elliptic-proxy): body field filtering with dot-path support
```

---

### Task 6: Elliptic forwarding

**Files:**
- Create: `elliptic-proxy/src/elliptic.ts`
- Create: `elliptic-proxy/tests/elliptic.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/elliptic.test.ts
import { describe, it, expect, vi } from "vitest";
import { forwardToElliptic } from "../src/elliptic.js";

// We mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("forwardToElliptic", () => {
  it("forwards request with re-signed headers", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const result = await forwardToElliptic({
      ellipticUrl: "https://api.elliptic.co",
      ellipticKey: "real-key",
      ellipticSecret: Buffer.from("real-secret").toString("base64"),
      method: "POST",
      path: "/v2/wallet/synchronous",
      body: '{"type":"wallet_exposure"}',
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://api.elliptic.co/v2/wallet/synchronous"
    );
    expect(options.method).toBe("POST");
    expect(options.headers["x-access-key"]).toBe("real-key");
    expect(options.headers["x-access-sign"]).toBeDefined();
    expect(options.headers["x-access-timestamp"]).toBeDefined();

    expect(result.status).toBe(200);
  });

  it("passes through error responses from Elliptic", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "bad request" }), { status: 400 })
    );

    const result = await forwardToElliptic({
      ellipticUrl: "https://api.elliptic.co",
      ellipticKey: "real-key",
      ellipticSecret: Buffer.from("real-secret").toString("base64"),
      method: "POST",
      path: "/v2/wallet/synchronous",
      body: "{}",
    });

    expect(result.status).toBe(400);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd elliptic-proxy && npx vitest run tests/elliptic.test.ts`
Expected: FAIL — module not found

**Step 3: Implement elliptic.ts**

```typescript
// src/elliptic.ts
import { computeHmacSignature } from "./auth.js";

interface ForwardRequest {
  ellipticUrl: string;
  ellipticKey: string;
  ellipticSecret: string;
  method: string;
  path: string;
  body: string;
}

interface ForwardResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export async function forwardToElliptic(
  request: ForwardRequest
): Promise<ForwardResponse> {
  const timestamp = Date.now().toString();
  const signature = computeHmacSignature(
    request.ellipticSecret,
    timestamp,
    request.method,
    request.path,
    request.body
  );

  const response = await fetch(request.ellipticUrl + request.path, {
    method: request.method,
    headers: {
      "content-type": "application/json",
      "x-access-key": request.ellipticKey,
      "x-access-sign": signature,
      "x-access-timestamp": timestamp,
    },
    body: request.body,
  });

  const responseBody = await response.text();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    status: response.status,
    headers: responseHeaders,
    body: responseBody,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `cd elliptic-proxy && npx vitest run tests/elliptic.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(elliptic-proxy): Elliptic request forwarding with HMAC re-signing
```

---

### Task 7: Cloud Function entry point — wiring everything together

**Files:**
- Create: `elliptic-proxy/src/index.ts`
- Create: `elliptic-proxy/tests/index.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/index.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "@google-cloud/functions-framework";
import { createHandler } from "../src/index.js";
import { computeHmacSignature } from "../src/auth.js";
import type { ResolvedConfig, ResolvedPartner } from "../src/config.js";

function makePartner(overrides: Partial<ResolvedPartner> = {}): ResolvedPartner {
  return {
    name: "test-partner",
    key: "partner-key",
    secret: Buffer.from("partner-secret").toString("base64"),
    rateLimitPerMinute: 100,
    maxBodyBytes: 10240,
    allowedBodyFields: {},
    ...overrides,
  };
}

function makeConfig(partner: ResolvedPartner): ResolvedConfig {
  return {
    elliptic: {
      url: "https://api.elliptic.co",
      key: "elliptic-key",
      secret: Buffer.from("elliptic-secret").toString("base64"),
    },
    defaults: {
      rateLimitPerMinute: 100,
      maxBodyBytes: 10240,
    },
    cacheTtlSeconds: 300,
    partners: {},
    partnerByKey: new Map([[partner.key, partner]]),
  };
}

function makeRequest(overrides: Record<string, unknown> = {}): Request {
  const partner = makePartner();
  const body = JSON.stringify({ type: "wallet_exposure" });
  const timestamp = Date.now().toString();
  const signature = computeHmacSignature(
    partner.secret,
    timestamp,
    "POST",
    "/v2/wallet/synchronous",
    body
  );

  return {
    method: "POST",
    path: "/v2/wallet/synchronous",
    headers: {
      "x-access-key": partner.key,
      "x-access-sign": signature,
      "x-access-timestamp": timestamp,
    },
    rawBody: Buffer.from(body),
    body: { type: "wallet_exposure" },
    ...overrides,
  } as unknown as Request;
}

function makeResponse(): Response & {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
} {
  const res = {
    statusCode: 200,
    body: "",
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    set(key: string, value: string) {
      res.headers[key] = value;
      return res;
    },
    send(body: string) {
      res.body = body;
      return res;
    },
  };
  return res as Response & typeof res;
}

describe("createHandler", () => {
  const mockForward = vi.fn();

  it("returns 401 when x-access-key is missing", async () => {
    const partner = makePartner();
    const config = makeConfig(partner);
    const configLoader = { get: vi.fn().mockResolvedValue(config) };
    const handler = createHandler(configLoader, mockForward);

    const req = makeRequest({ headers: {} });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when partner key is unknown", async () => {
    const partner = makePartner();
    const config = makeConfig(partner);
    const configLoader = { get: vi.fn().mockResolvedValue(config) };
    const handler = createHandler(configLoader, mockForward);

    const req = makeRequest({
      headers: {
        "x-access-key": "unknown-key",
        "x-access-sign": "sig",
        "x-access-timestamp": "123",
      },
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when signature is invalid", async () => {
    const partner = makePartner();
    const config = makeConfig(partner);
    const configLoader = { get: vi.fn().mockResolvedValue(config) };
    const handler = createHandler(configLoader, mockForward);

    const req = makeRequest({
      headers: {
        "x-access-key": partner.key,
        "x-access-sign": "bad-signature",
        "x-access-timestamp": Date.now().toString(),
      },
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns 413 when body exceeds maxBodyBytes", async () => {
    const partner = makePartner({ maxBodyBytes: 5 });
    const config = makeConfig(partner);
    const configLoader = { get: vi.fn().mockResolvedValue(config) };
    const handler = createHandler(configLoader, mockForward);

    const body = '{"type":"wallet_exposure"}';
    const timestamp = Date.now().toString();
    const signature = computeHmacSignature(
      partner.secret,
      timestamp,
      "POST",
      "/v2/wallet/synchronous",
      body
    );

    const req = makeRequest({
      headers: {
        "x-access-key": partner.key,
        "x-access-sign": signature,
        "x-access-timestamp": timestamp,
      },
      rawBody: Buffer.from(body),
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(413);
  });

  it("returns 403 when body field is not allowed", async () => {
    const partner = makePartner({
      allowedBodyFields: { type: ["wallet_exposure"] },
    });
    const config = makeConfig(partner);
    const configLoader = { get: vi.fn().mockResolvedValue(config) };
    const handler = createHandler(configLoader, mockForward);

    const body = JSON.stringify({ type: "transaction_exposure" });
    const timestamp = Date.now().toString();
    const signature = computeHmacSignature(
      partner.secret,
      timestamp,
      "POST",
      "/v2/wallet/synchronous",
      body
    );

    const req = makeRequest({
      headers: {
        "x-access-key": partner.key,
        "x-access-sign": signature,
        "x-access-timestamp": timestamp,
      },
      rawBody: Buffer.from(body),
      body: { type: "transaction_exposure" },
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(403);
  });

  it("forwards valid request and returns Elliptic response", async () => {
    const partner = makePartner();
    const config = makeConfig(partner);
    const configLoader = { get: vi.fn().mockResolvedValue(config) };

    mockForward.mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"id":"abc"}',
    });

    const handler = createHandler(configLoader, mockForward);
    const req = makeRequest();
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"id":"abc"}');
    expect(mockForward).toHaveBeenCalledOnce();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd elliptic-proxy && npx vitest run tests/index.test.ts`
Expected: FAIL — module not found

**Step 3: Implement index.ts**

```typescript
// src/index.ts
import * as ff from "@google-cloud/functions-framework";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import type { Request, Response } from "@google-cloud/functions-framework";
import { ConfigLoader, type ResolvedConfig } from "./config.js";
import { verifySignature } from "./auth.js";
import { RateLimiter } from "./rate-limit.js";
import { validateBodyFields } from "./body-filter.js";
import { forwardToElliptic, type ForwardResponse } from "./elliptic.js";

interface ConfigSource {
  get(): Promise<ResolvedConfig>;
}

type Forwarder = (request: {
  ellipticUrl: string;
  ellipticKey: string;
  ellipticSecret: string;
  method: string;
  path: string;
  body: string;
}) => Promise<ForwardResponse>;

const rateLimiter = new RateLimiter();

export function createHandler(
  configSource: ConfigSource,
  forward: Forwarder
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response) => {
    let config: ResolvedConfig;
    try {
      config = await configSource.get();
    } catch {
      res.status(503).send(JSON.stringify({ error: "service unavailable" }));
      return;
    }

    const accessKey = req.headers["x-access-key"] as string | undefined;
    const accessSign = req.headers["x-access-sign"] as string | undefined;
    const accessTimestamp = req.headers["x-access-timestamp"] as
      | string
      | undefined;

    if (!accessKey || !accessSign || !accessTimestamp) {
      res.status(401).send(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const partner = config.partnerByKey.get(accessKey);
    if (!partner) {
      res.status(401).send(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const rawBody = req.rawBody?.toString() ?? "";

    if (
      !verifySignature(
        partner.secret,
        accessSign,
        accessTimestamp,
        req.method,
        req.path,
        rawBody
      )
    ) {
      res.status(401).send(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (req.rawBody && req.rawBody.length > partner.maxBodyBytes) {
      res.status(413).send(JSON.stringify({ error: "payload too large" }));
      return;
    }

    if (!rateLimiter.check(partner.name, partner.rateLimitPerMinute)) {
      res.status(429).send(JSON.stringify({ error: "too many requests" }));
      return;
    }

    const bodyObject =
      typeof req.body === "object" && req.body !== null ? req.body : {};
    if (!validateBodyFields(bodyObject, partner.allowedBodyFields)) {
      res.status(403).send(JSON.stringify({ error: "forbidden" }));
      return;
    }

    const result = await forward({
      ellipticUrl: config.elliptic.url,
      ellipticKey: config.elliptic.key,
      ellipticSecret: config.elliptic.secret,
      method: req.method,
      path: req.path,
      body: rawBody,
    });

    res.status(result.status);
    if (result.headers["content-type"]) {
      res.set("content-type", result.headers["content-type"]);
    }
    res.send(result.body);
  };
}

// Production wiring — only runs when deployed, not during tests
function createSecretFetcher(): () => Promise<string> {
  const client = new SecretManagerServiceClient();
  const secretName = process.env.PROXY_CONFIG;
  return async () => {
    if (!secretName) throw new Error("PROXY_CONFIG env var not set");
    const [version] = await client.accessSecretVersion({
      name: secretName,
    });
    return version.payload?.data?.toString() ?? "";
  };
}

const configLoader = new ConfigLoader(createSecretFetcher());

ff.http("ellipticProxy", createHandler(configLoader, forwardToElliptic));
```

Note: `elliptic.ts` needs a minor update to export the `ForwardResponse` type. Add `export` to the interface definition.

**Step 4: Run tests to verify they pass**

Run: `cd elliptic-proxy && npx vitest run tests/index.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(elliptic-proxy): Cloud Function entry point wiring all components
```

---

### Task 8: Build verification and lint setup

**Files:**
- Create: `elliptic-proxy/.prettierrc`
- Create: `elliptic-proxy/eslint.config.js`
- Create: `elliptic-proxy/vitest.config.ts`

**Step 1: Create config files**

`.prettierrc`:
```json
{
  "singleQuote": false,
  "trailingComma": "es5"
}
```

`eslint.config.js`:
```javascript
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/"],
  }
);
```

`vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
```

**Step 2: Run full verification**

Run:
```bash
cd elliptic-proxy
npm run build
npm run lint
npm test
```

Expected: All pass

**Step 3: Commit**

```
chore(elliptic-proxy): lint and test configuration
```

---

### Task 9: End-to-end integration test with mocked Elliptic

**Files:**
- Create: `elliptic-proxy/tests/integration.test.ts`

**Step 1: Write the integration test**

This test exercises the full handler flow with a mock forwarder:

```typescript
// tests/integration.test.ts
import { describe, it, expect, vi } from "vitest";
import { createHandler } from "../src/index.js";
import { computeHmacSignature } from "../src/auth.js";
import type { Request } from "@google-cloud/functions-framework";
import type { ResolvedConfig } from "../src/config.js";

function fullFlowTest(
  description: string,
  setup: {
    bodyOverride?: Record<string, unknown>;
    allowedBodyFields?: Record<string, string[]>;
  },
  expectedStatus: number
) {
  it(description, async () => {
    const partnerSecret = Buffer.from("integration-secret").toString("base64");
    const partnerKey = "integration-key";

    const config: ResolvedConfig = {
      elliptic: {
        url: "https://api.elliptic.co",
        key: "real-key",
        secret: Buffer.from("real-secret").toString("base64"),
      },
      defaults: { rateLimitPerMinute: 100, maxBodyBytes: 10240 },
      cacheTtlSeconds: 300,
      partners: {},
      partnerByKey: new Map([
        [
          partnerKey,
          {
            name: "integration-partner",
            key: partnerKey,
            secret: partnerSecret,
            rateLimitPerMinute: 100,
            maxBodyBytes: 10240,
            allowedBodyFields: setup.allowedBodyFields ?? {},
          },
        ],
      ]),
    };

    const body = JSON.stringify(
      setup.bodyOverride ?? {
        type: "wallet_exposure",
        subject: { asset: "holistic", type: "address", hash: "0xabc" },
      }
    );

    const timestamp = Date.now().toString();
    const signature = computeHmacSignature(
      partnerSecret,
      timestamp,
      "POST",
      "/v2/wallet/synchronous",
      body
    );

    const req = {
      method: "POST",
      path: "/v2/wallet/synchronous",
      headers: {
        "x-access-key": partnerKey,
        "x-access-sign": signature,
        "x-access-timestamp": timestamp,
      },
      rawBody: Buffer.from(body),
      body: JSON.parse(body),
    } as unknown as Request;

    const mockForward = vi.fn().mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"risk_score":0.1}',
    });

    const res = {
      statusCode: 0,
      body: "",
      headers: {} as Record<string, string>,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      set(key: string, value: string) {
        res.headers[key] = value;
        return res;
      },
      send(b: string) {
        res.body = b;
        return res;
      },
    };

    const handler = createHandler(
      { get: vi.fn().mockResolvedValue(config) },
      mockForward
    );
    await handler(req, res as any);

    expect(res.statusCode).toBe(expectedStatus);
  });
}

describe("integration: full request flow", () => {
  fullFlowTest("happy path — valid request is forwarded", {}, 200);

  fullFlowTest(
    "blocked by body filter",
    {
      bodyOverride: { type: "transaction_exposure" },
      allowedBodyFields: { type: ["wallet_exposure"] },
    },
    403
  );
});
```

**Step 2: Run**

Run: `cd elliptic-proxy && npx vitest run tests/integration.test.ts`
Expected: PASS

**Step 3: Commit**

```
test(elliptic-proxy): integration test for full request flow
```

---

### Task 10: Final verification

**Step 1: Run all checks**

```bash
cd elliptic-proxy
npm run build
npm run lint
npm test
```

Expected: All pass, zero warnings.

**Step 2: Verify project structure**

```bash
ls -R elliptic-proxy/src/ elliptic-proxy/tests/
```

Expected:
```
elliptic-proxy/src/:
index.ts  config.ts  auth.ts  elliptic.ts  rate-limit.ts  body-filter.ts

elliptic-proxy/tests/:
config.test.ts  auth.test.ts  rate-limit.test.ts  body-filter.test.ts
elliptic.test.ts  index.test.ts  integration.test.ts
```
