// tests/handler.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "@google-cloud/functions-framework";
import { createHandler } from "../src/handler.js";
import { computeHmacSignature } from "../src/auth.js";
import type { Config } from "../src/config.js";

const PARTNER_SECRET = Buffer.from("partner-secret").toString("base64");

function makeConfig(): Config {
  return {
    elliptic: {
      url: "https://api.elliptic.co",
      key: "elliptic-key",
      secret: Buffer.from("elliptic-secret").toString("base64"),
      timeoutMs: 10000,
    },
    rateLimitPerMinute: 100,
    maxBodyBytes: 10240,
    configCacheTtlSeconds: 300,
    blockedCacheTtlSeconds: 300,
    partners: { "test-partner": PARTNER_SECRET },
  };
}

function makeRequest(
  overrides: Record<string, unknown> = {},
  address = "0xabc123"
): Request {
  const body = JSON.stringify({ address });
  const timestamp = Date.now().toString();
  const signature = computeHmacSignature(
    PARTNER_SECRET,
    timestamp,
    "POST",
    "/screen",
    body
  );

  return {
    method: "POST",
    path: "/screen",
    headers: {
      "x-access-key": "test-partner",
      "x-access-sign": signature,
      "x-access-timestamp": timestamp,
    },
    rawBody: Buffer.from(body),
    body: { address },
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

  beforeEach(() => {
    mockForward.mockReset();
  });

  it("returns 401 when x-access-key is missing", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    const handler = createHandler(configLoader, mockForward);

    const req = makeRequest({ headers: {} });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when partner is unknown", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    const handler = createHandler(configLoader, mockForward);

    const req = makeRequest({
      headers: {
        "x-access-key": "unknown-partner",
        "x-access-sign": "sig",
        "x-access-timestamp": Date.now().toString(),
      },
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("unauthorized");
  });

  it("returns 401 when signature is invalid", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    const handler = createHandler(configLoader, mockForward);

    const req = makeRequest({
      headers: {
        "x-access-key": "test-partner",
        "x-access-sign": "bad-signature",
        "x-access-timestamp": Date.now().toString(),
      },
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns 413 when body exceeds maxBodyBytes", async () => {
    const config = makeConfig();
    config.maxBodyBytes = 5;
    const configLoader = { get: vi.fn().mockResolvedValue(config) };
    const handler = createHandler(configLoader, mockForward);

    const body = '{"address":"0xabc123"}';
    const timestamp = Date.now().toString();
    const signature = computeHmacSignature(
      PARTNER_SECRET,
      timestamp,
      "POST",
      "/screen",
      body
    );

    const req = makeRequest({
      headers: {
        "x-access-key": "test-partner",
        "x-access-sign": signature,
        "x-access-timestamp": timestamp,
      },
      rawBody: Buffer.from(body),
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(413);
  });

  it("returns 400 when address is missing", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    const handler = createHandler(configLoader, mockForward);

    const body = JSON.stringify({ notAddress: "foo" });
    const timestamp = Date.now().toString();
    const signature = computeHmacSignature(
      PARTNER_SECRET,
      timestamp,
      "POST",
      "/screen",
      body
    );

    const req = makeRequest({
      headers: {
        "x-access-key": "test-partner",
        "x-access-sign": signature,
        "x-access-timestamp": timestamp,
      },
      rawBody: Buffer.from(body),
      body: { notAddress: "foo" },
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "missing address" });
  });

  it("returns 400 for whitespace-only address", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    const handler = createHandler(configLoader, mockForward);

    const body = JSON.stringify({ address: "   " });
    const timestamp = Date.now().toString();
    const signature = computeHmacSignature(
      PARTNER_SECRET,
      timestamp,
      "POST",
      "/screen",
      body
    );

    const req = makeRequest({
      headers: {
        "x-access-key": "test-partner",
        "x-access-sign": signature,
        "x-access-timestamp": timestamp,
      },
      rawBody: Buffer.from(body),
      body: { address: "   " },
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid address format" });
  });

  it("returns 400 for excessively long address", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    const handler = createHandler(configLoader, mockForward);

    const longAddress = "0x" + "a".repeat(100);
    const body = JSON.stringify({ address: longAddress });
    const timestamp = Date.now().toString();
    const signature = computeHmacSignature(
      PARTNER_SECRET,
      timestamp,
      "POST",
      "/screen",
      body
    );

    const req = makeRequest({
      headers: {
        "x-access-key": "test-partner",
        "x-access-sign": signature,
        "x-access-timestamp": timestamp,
      },
      rawBody: Buffer.from(body),
      body: { address: longAddress },
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid address format" });
  });

  it("returns 400 for address with non-hex characters", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    const handler = createHandler(configLoader, mockForward);

    const req = makeRequest({}, "0xGHIJKL");
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid address format" });
  });

  it("returns blocked when Elliptic response triggers scoring rules", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };

    mockForward.mockResolvedValue({
      status: 200,
      durationMs: 5,
      body: JSON.stringify({
        process_status: "complete",
        evaluation_detail: {
          source: [
            {
              rule_id: "1f86dce1-166a-4749-a5df-3972fae7635a",
              matched_elements: [
                {
                  contribution_percentage: 5,
                  contribution_value: { usd: 100 },
                  counterparty_percentage: 10,
                  counterparty_value: { usd: 50 },
                },
              ],
            },
          ],
        },
      }),
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = createHandler(configLoader, mockForward);
    const req = makeRequest();
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ blocked: true, source: "elliptic" });
    expect(mockForward).toHaveBeenCalledWith(
      expect.objectContaining({ address: "0xabc123" })
    );

    const logCall = logSpy.mock.calls.find((call) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.status === 200 && parsed.result === "blocked";
    });
    expect(logCall).toBeDefined();
    const logData = JSON.parse(logCall![0] as string);
    expect(logData.scoringReason).toBe("rule_triggered");
    expect(logData.triggeringRuleIds).toContain(
      "1f86dce1-166a-4749-a5df-3972fae7635a"
    );
    logSpy.mockRestore();
  });

  it("returns not blocked for clean Elliptic response", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };

    mockForward.mockResolvedValue({
      status: 200,
      durationMs: 5,
      body: JSON.stringify({
        process_status: "complete",
        evaluation_detail: { source: [], destination: [] },
      }),
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = createHandler(configLoader, mockForward);
    const req = makeRequest({}, "0xc1ea0");
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      blocked: false,
      source: "elliptic",
    });

    const logCall = logSpy.mock.calls.find((call) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.status === 200 && parsed.result === "allowed";
    });
    expect(logCall).toBeDefined();
    const logData = JSON.parse(logCall![0] as string);
    expect(logData.scoringReason).toBe("clean");
    logSpy.mockRestore();
  });

  it("returns 504 when forward throws a network error", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };

    mockForward.mockRejectedValue(new Error("fetch failed"));

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createHandler(configLoader, mockForward);
    const req = makeRequest({}, "0xfade0001");
    const res = makeResponse();
    await handler(req, res);

    // Elliptic unreachable is the upstream's fault domain: 504, distinct from
    // the 503 a config-load failure returns.
    expect(res.statusCode).toBe(504);
    expect(JSON.parse(res.body)).toEqual({ error: "upstream unreachable" });
    spy.mockRestore();
  });

  it("returns 503 when the config cannot be loaded", async () => {
    const configLoader = {
      get: vi.fn().mockRejectedValue(new Error("secret manager down")),
    };

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createHandler(configLoader, mockForward);
    const res = makeResponse();
    await handler(makeRequest(), res);

    // A config-load failure is the proxy's own fault domain: 503, distinct
    // from the 504 returned when only the path to Elliptic is down.
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "service unavailable" });
    expect(mockForward).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns 502 when Elliptic returns a non-2xx status", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };

    mockForward.mockResolvedValue({
      status: 429,
      durationMs: 5,
      body: JSON.stringify({ error: "rate limited" }),
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createHandler(configLoader, mockForward);
    const req = makeRequest({}, "0xbad0429");
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "upstream error" });
    spy.mockRestore();
  });

  it("allows when Elliptic returns 404 NotInBlockchain", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };

    mockForward.mockResolvedValue({
      status: 404,
      durationMs: 5,
      body: JSON.stringify({
        id: "6cc452d5-bbcc-43e5-a615-0093adfb38a7",
        name: "NotInBlockchain",
        message:
          "The submitted address with hash 0xabc has not yet been processed into the Elliptic tool or does not exist on the blockchain.",
        status: 404,
      }),
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createHandler(configLoader, mockForward);
    const req = makeRequest({}, "0xf1e5ad");
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      blocked: false,
      source: "elliptic",
    });
    expect(errorSpy).not.toHaveBeenCalled();
    const allowedLog = logSpy.mock.calls.find((call) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.scoringReason === "not_in_blockchain";
    });
    expect(allowedLog).toBeDefined();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("allows on any 404 body shape", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };

    mockForward.mockResolvedValue({
      status: 404,
      durationMs: 5,
      body: "<html>not found</html>",
    });

    const handler = createHandler(configLoader, mockForward);
    const res = makeResponse();
    await handler(makeRequest({}, "0xab07f0d"), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      blocked: false,
      source: "elliptic",
    });
  });

  it("returns cached blocked result without calling forwarder again", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };

    // First request: Elliptic says blocked
    mockForward.mockResolvedValue({
      status: 200,
      durationMs: 5,
      body: JSON.stringify({
        process_status: "complete",
        evaluation_detail: {
          source: [
            {
              rule_id: "1f86dce1-166a-4749-a5df-3972fae7635a",
              matched_elements: [
                {
                  contribution_percentage: 5,
                  contribution_value: { usd: 100 },
                  counterparty_percentage: 10,
                  counterparty_value: { usd: 50 },
                },
              ],
            },
          ],
        },
      }),
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = createHandler(configLoader, mockForward);

    const res1 = makeResponse();
    await handler(makeRequest({}, "0xcacbed"), res1);
    expect(res1.statusCode).toBe(200);
    expect(JSON.parse(res1.body)).toEqual({
      blocked: true,
      source: "elliptic",
    });
    expect(mockForward).toHaveBeenCalledTimes(1);

    // Second request: same address should return cached result
    mockForward.mockReset();
    logSpy.mockClear();
    const res2 = makeResponse();
    await handler(makeRequest({}, "0xcacbed"), res2);
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.body)).toEqual({ blocked: true, source: "cache" });
    expect(mockForward).not.toHaveBeenCalled();

    const cachedLog = logSpy.mock.calls.find((call) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.result === "cached";
    });
    expect(cachedLog).toBeDefined();
    logSpy.mockRestore();
  });

  it("does not cache address as blocked on Elliptic error", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };

    // First request: Elliptic returns 500
    mockForward.mockResolvedValue({
      status: 500,
      durationMs: 5,
      body: JSON.stringify({ error: "internal" }),
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createHandler(configLoader, mockForward);

    const res1 = makeResponse();
    await handler(makeRequest({}, "0xd0e5cafe"), res1);
    expect(res1.statusCode).toBe(502);

    // Second request: Elliptic recovers, returns clean
    mockForward.mockResolvedValue({
      status: 200,
      durationMs: 5,
      body: JSON.stringify({
        process_status: "complete",
        evaluation_detail: { source: [], destination: [] },
      }),
    });

    const res2 = makeResponse();
    await handler(makeRequest({}, "0xd0e5cafe"), res2);
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.body)).toEqual({
      blocked: false,
      source: "elliptic",
    });
    // If the address had been erroneously cached as blocked on the 500,
    // this second request would return { blocked: true } from cache.
    spy.mockRestore();
  });

  it("returns 502 and does not cache on malformed Elliptic response", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };

    mockForward.mockResolvedValue({
      status: 200,
      durationMs: 5,
      body: "<html>Service Unavailable</html>",
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createHandler(configLoader, mockForward);

    const res1 = makeResponse();
    await handler(makeRequest({}, "0xbadcafe"), res1);
    expect(res1.statusCode).toBe(502);

    // Second request should still call Elliptic (not cached)
    mockForward.mockResolvedValue({
      status: 200,
      durationMs: 5,
      body: JSON.stringify({
        process_status: "complete",
        evaluation_detail: { source: [], destination: [] },
      }),
    });

    const res2 = makeResponse();
    await handler(makeRequest({}, "0xbadcafe"), res2);
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.body)).toEqual({
      blocked: false,
      source: "elliptic",
    });
    spy.mockRestore();
  });

  it("allows when Elliptic returns incomplete status", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };

    mockForward.mockResolvedValue({
      status: 200,
      durationMs: 5,
      body: JSON.stringify({ process_status: "running" }),
    });

    const handler = createHandler(configLoader, mockForward);
    const req = makeRequest({}, "0x1c0");
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      blocked: false,
      source: "elliptic",
    });
  });

  describe("operator policy lists", () => {
    function makePolicyConfig(overrides: Partial<Config> = {}): Config {
      return { ...makeConfig(), ...overrides };
    }

    it("blocks via additionalBlockedAddresses without calling Elliptic", async () => {
      const configLoader = {
        get: vi
          .fn()
          .mockResolvedValue(
            makePolicyConfig({ additionalBlockedAddresses: ["0xdeadbeef"] })
          ),
      };
      const handler = createHandler(configLoader, mockForward);
      const req = makeRequest({}, "0xdeadbeef");
      const res = makeResponse();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        blocked: true,
        source: "blocklist",
      });
      expect(mockForward).not.toHaveBeenCalled();
    });

    it("allows via blockOverrideAddresses without calling Elliptic", async () => {
      const configLoader = {
        get: vi
          .fn()
          .mockResolvedValue(
            makePolicyConfig({ blockOverrideAddresses: ["0xcafe"] })
          ),
      };
      const handler = createHandler(configLoader, mockForward);
      const req = makeRequest({}, "0xCAFE");
      const res = makeResponse();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        blocked: false,
        source: "allowlist",
      });
      expect(mockForward).not.toHaveBeenCalled();
    });

    it("allowlist wins over blocklist when both list the same address", async () => {
      const configLoader = {
        get: vi.fn().mockResolvedValue(
          makePolicyConfig({
            additionalBlockedAddresses: ["0xdeadbeef"],
            blockOverrideAddresses: ["0xdeadbeef"],
          })
        ),
      };
      const handler = createHandler(configLoader, mockForward);
      const req = makeRequest({}, "0xdeadbeef");
      const res = makeResponse();
      await handler(req, res);

      expect(JSON.parse(res.body)).toEqual({
        blocked: false,
        source: "allowlist",
      });
      expect(mockForward).not.toHaveBeenCalled();
    });

    it("skipElliptic returns allowed without calling Elliptic when no list matches", async () => {
      const configLoader = {
        get: vi
          .fn()
          .mockResolvedValue(makePolicyConfig({ skipElliptic: true })),
      };
      const handler = createHandler(configLoader, mockForward);
      const req = makeRequest({}, "0xf00d");
      const res = makeResponse();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ blocked: false, source: "skip" });
      expect(mockForward).not.toHaveBeenCalled();
    });

    it("blocklist still applies under skipElliptic", async () => {
      const configLoader = {
        get: vi.fn().mockResolvedValue(
          makePolicyConfig({
            skipElliptic: true,
            additionalBlockedAddresses: ["0xdeadbeef"],
          })
        ),
      };
      const handler = createHandler(configLoader, mockForward);
      const req = makeRequest({}, "0xdeadbeef");
      const res = makeResponse();
      await handler(req, res);

      expect(JSON.parse(res.body)).toEqual({
        blocked: true,
        source: "blocklist",
      });
      expect(mockForward).not.toHaveBeenCalled();
    });

    it("blocklist overrides Elliptic on a clean live response", async () => {
      mockForward.mockResolvedValue({
        status: 200,
        durationMs: 5,
        body: JSON.stringify({
          process_status: "complete",
          evaluation_detail: { source: [], destination: [] },
        }),
      });
      const configLoader = {
        get: vi
          .fn()
          .mockResolvedValue(
            makePolicyConfig({ additionalBlockedAddresses: ["0xabc123"] })
          ),
      };
      const handler = createHandler(configLoader, mockForward);
      const req = makeRequest();
      const res = makeResponse();
      await handler(req, res);

      expect(JSON.parse(res.body)).toEqual({
        blocked: true,
        source: "blocklist",
      });
      expect(mockForward).not.toHaveBeenCalled();
    });

    it("matches policy lists case-insensitively (handler lowercases the address)", async () => {
      const configLoader = {
        get: vi
          .fn()
          .mockResolvedValue(
            makePolicyConfig({ additionalBlockedAddresses: ["0xabcdef"] })
          ),
      };
      const handler = createHandler(configLoader, mockForward);
      const req = makeRequest({}, "0xABCDEF");
      const res = makeResponse();
      await handler(req, res);

      expect(JSON.parse(res.body)).toEqual({
        blocked: true,
        source: "blocklist",
      });
    });
  });
});
