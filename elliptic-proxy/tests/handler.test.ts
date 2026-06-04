// tests/handler.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHandler } from "../src/handler.js";
import { computeHmacSignature } from "../src/auth.js";
import { mockableForwarder } from "../src/mock-elliptic.js";
import type { Config } from "../src/config.js";
import {
  PARTNER_SECRET,
  makeConfig,
  makeMockEllipticConfig,
  makeRequest,
  makeResponse,
} from "./helpers.js";

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

  describe("mock Elliptic upstream", () => {
    function makeMockUpstreamHandler(config: Config) {
      const configSource = { get: vi.fn().mockResolvedValue(config) };
      // mockForward stands in for the live forwarder: the dispatch must never
      // reach it when the mock upstream is selected.
      return createHandler(configSource, mockableForwarder(mockForward));
    }

    it("allows an unlisted address without calling live Elliptic", async () => {
      const handler = makeMockUpstreamHandler(makeMockEllipticConfig());
      const req = makeRequest({}, "0xf00d");
      const res = makeResponse();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        blocked: false,
        source: "mock",
      });
      expect(mockForward).not.toHaveBeenCalled();
    });

    it("blocks a deny-listed address without calling live Elliptic", async () => {
      const handler = makeMockUpstreamHandler(
        makeMockEllipticConfig({ additionalBlockedAddresses: ["0xdeadbeef"] })
      );
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
  });

  describe("operator lists", () => {
    it("blocks a deny-listed address when screening live, without calling Elliptic", async () => {
      const configLoader = {
        get: vi
          .fn()
          .mockResolvedValue(
            makeConfig({ additionalBlockedAddresses: ["0xabc123"] })
          ),
      };
      const handler = createHandler(configLoader, mockForward);
      const req = makeRequest(); // 0xabc123 — deny-listed
      const res = makeResponse();
      await handler(req, res);

      expect(JSON.parse(res.body)).toEqual({
        blocked: true,
        source: "blocklist",
      });
      expect(mockForward).not.toHaveBeenCalled();
    });

    it("matches a zero-padded deny entry against a stripped address", async () => {
      // List entries are matched on the canonical felt: an entry written
      // zero-padded blocks the leading-zero-stripped address a caller sends.
      const configLoader = {
        get: vi
          .fn()
          .mockResolvedValue(
            makeConfig({ additionalBlockedAddresses: ["0x00deadbeef"] })
          ),
      };
      const handler = createHandler(configLoader, mockForward);
      const res = makeResponse();
      await handler(makeRequest({}, "0xdeadbeef"), res);

      expect(JSON.parse(res.body)).toEqual({
        blocked: true,
        source: "blocklist",
      });
      expect(mockForward).not.toHaveBeenCalled();
    });

    it("allow list wins over the deny list", async () => {
      const configLoader = {
        get: vi.fn().mockResolvedValue(
          makeConfig({
            additionalBlockedAddresses: ["0xabc123"],
            blockOverrideAddresses: ["0xabc123"],
          })
        ),
      };
      const handler = createHandler(configLoader, mockForward);
      const res = makeResponse();
      await handler(makeRequest(), res);

      expect(JSON.parse(res.body)).toEqual({
        blocked: false,
        source: "allowlist",
      });
      expect(mockForward).not.toHaveBeenCalled();
    });

    it("allow list wins over an upstream block, without calling Elliptic", async () => {
      const configLoader = {
        get: vi
          .fn()
          .mockResolvedValue(
            makeConfig({ blockOverrideAddresses: ["0xabc123"] })
          ),
      };
      const handler = createHandler(configLoader, mockForward);
      const res = makeResponse();
      await handler(makeRequest(), res);

      expect(JSON.parse(res.body)).toEqual({
        blocked: false,
        source: "allowlist",
      });
      // The verdict is decided before any upstream call, so even an upstream
      // that would block can't override the operator allow.
      expect(mockForward).not.toHaveBeenCalled();
    });

    it("allow list rescues an address already cached as blocked", async () => {
      // First request: no lists, Elliptic blocks → cached.
      const blockedBody = JSON.stringify({
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
      });
      mockForward.mockResolvedValue({
        status: 200,
        durationMs: 5,
        body: blockedBody,
      });
      const config = makeConfig();
      const configLoader = { get: vi.fn().mockResolvedValue(config) };
      const handler = createHandler(configLoader, mockForward);

      const first = makeResponse();
      await handler(makeRequest({}, "0xcacbed"), first);
      expect(JSON.parse(first.body)).toEqual({
        blocked: true,
        source: "elliptic",
      });

      // Config refresh adds the allow override: the cached block must not win.
      configLoader.get.mockResolvedValue(
        makeConfig({ blockOverrideAddresses: ["0xcacbed"] })
      );
      const second = makeResponse();
      await handler(makeRequest({}, "0xcacbed"), second);
      expect(JSON.parse(second.body)).toEqual({
        blocked: false,
        source: "allowlist",
      });
    });
  });

  it("returns 400 for an address >= 2**251", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    const handler = createHandler(configLoader, mockForward);

    const tooLarge = "0x8" + "0".repeat(62); // exactly 2**251, beyond the address bound
    const req = makeRequest({}, tooLarge);
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid address");
    expect(mockForward).not.toHaveBeenCalled();
  });

  it("returns 400 for a 64-hex-digit address (not a felt)", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    const handler = createHandler(configLoader, mockForward);

    const tooLong = "0x" + "f".repeat(64); // 2**256-1 can't fit a felt252
    const res = makeResponse();
    await handler(makeRequest({}, tooLong), res);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid address format");
    expect(mockForward).not.toHaveBeenCalled();
  });
});
