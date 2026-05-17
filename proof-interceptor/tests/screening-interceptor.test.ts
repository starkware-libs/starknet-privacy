// tests/screening-interceptor.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  ScreeningInterceptor,
  getScreenedAddresses,
  isSinglePoolCall,
  type ScreeningConfig,
} from "../src/screening-interceptor.js";
import type { ProveTxnV3 } from "../src/types.js";

// Test addresses and values — must be valid hex for ABI decoding
const USER_ADDR = "0xaaa111";
const PRIVATE_KEY = "0xbbb222";
const TOKEN = "0xdead";
const AMOUNT = "0x64";
const POOL_ADDR = "0xpool";

function sampleTransaction(calldataOverride?: string[]): ProveTxnV3 {
  return {
    type: "INVOKE",
    version: "0x3",
    sender_address: "0xcontract",
    calldata: calldataOverride ?? [
      "0x1", // 1 call
      "0xpool", // call.to (not decoded)
      "0xselector", // call.selector (not decoded)
      "0x6", // inner calldata length
      USER_ADDR,
      PRIVATE_KEY,
      "0x1", // 1 action
      "0x5", // Deposit variant
      TOKEN,
      AMOUNT,
    ],
    signature: ["0x1"],
    nonce: "0x0",
    resource_bounds: {},
    tip: "0x0",
    paymaster_data: [],
    account_deployment_data: [],
    nonce_data_availability_mode: "L1",
    fee_data_availability_mode: "L1",
  } as unknown as ProveTxnV3;
}

describe("getScreenedAddresses", () => {
  it("extracts user_addr when transaction contains a deposit", () => {
    const addresses = getScreenedAddresses(sampleTransaction(), POOL_ADDR);
    expect(addresses).toEqual(["0xaaa111"]);
  });

  it("returns empty when contract address does not match pool address", () => {
    const addresses = getScreenedAddresses(sampleTransaction(), "0xother");
    expect(addresses).toEqual([]);
  });

  it("matches pool address regardless of leading zeros", () => {
    const addresses = getScreenedAddresses(
      sampleTransaction([
        "0x1",
        "0x00000abc",
        "0xsel",
        "0x6",
        USER_ADDR,
        PRIVATE_KEY,
        "0x1",
        "0x5",
        TOKEN,
        AMOUNT,
      ]),
      "0xabc"
    );
    expect(addresses).toEqual(["0xaaa111"]);
  });

  it("returns empty for short calldata", () => {
    const addresses = getScreenedAddresses(
      sampleTransaction(["0x1", POOL_ADDR, "0xsel"]),
      POOL_ADDR
    );
    expect(addresses).toEqual([]);
  });

  it("normalizes addresses by stripping leading zeros", () => {
    const addresses = getScreenedAddresses(
      sampleTransaction([
        "0x1",
        POOL_ADDR,
        "0xsel",
        "0x6",
        "0x00004a1b2c",
        PRIVATE_KEY,
        "0x1",
        "0x5",
        TOKEN,
        AMOUNT,
      ]),
      POOL_ADDR
    );
    expect(addresses).toEqual(["0x4a1b2c"]);
  });

  it("normalizes all-zero address to 0x0", () => {
    const addresses = getScreenedAddresses(
      sampleTransaction([
        "0x1",
        POOL_ADDR,
        "0xsel",
        "0x6",
        "0x0000000000",
        PRIVATE_KEY,
        "0x1",
        "0x5",
        TOKEN,
        AMOUNT,
      ]),
      POOL_ADDR
    );
    expect(addresses).toEqual(["0x0"]);
  });

  it("returns empty when inner_calldata_len is too small", () => {
    const addresses = getScreenedAddresses(
      sampleTransaction(["0x1", POOL_ADDR, "0xsel", "0x2", "0x1", "0x2"]),
      POOL_ADDR
    );
    expect(addresses).toEqual([]);
  });

  it("returns empty when inner_calldata_len is not valid hex", () => {
    const addresses = getScreenedAddresses(
      sampleTransaction(["0x1", POOL_ADDR, "0xsel", "not-hex", "0x1"]),
      POOL_ADDR
    );
    expect(addresses).toEqual([]);
  });

  it("handles address without 0x prefix", () => {
    const addresses = getScreenedAddresses(
      sampleTransaction([
        "0x1",
        POOL_ADDR,
        "0xsel",
        "0x6",
        "4a1b2c",
        PRIVATE_KEY,
        "0x1",
        "0x5",
        TOKEN,
        AMOUNT,
      ]),
      POOL_ADDR
    );
    expect(addresses).toEqual(["0x4a1b2c"]);
  });

  it("returns empty when calldata[0] is not 0x1", () => {
    const addresses = getScreenedAddresses(
      sampleTransaction(["0x2", POOL_ADDR, "0xsel", "0x6", "0x1"]),
      POOL_ADDR
    );
    expect(addresses).toEqual([]);
  });

  // Attackers must not be able to dodge the single-pool-call check by
  // submitting equivalent encodings of 1 (uppercase prefix, leading zeros,
  // bare "1" with no prefix). All of these are the same felt value.
  it.each([["0X1"], ["0x01"], ["0x001"], ["0x0001"], ["1"]])(
    "treats %s as a single-call count (no normalization bypass)",
    (callCount) => {
      const addresses = getScreenedAddresses(
        sampleTransaction([
          callCount,
          POOL_ADDR,
          "0xselector",
          "0x6",
          USER_ADDR,
          PRIVATE_KEY,
          "0x1",
          "0x5",
          TOKEN,
          AMOUNT,
        ]),
        POOL_ADDR
      );
      expect(addresses).toEqual(["0xaaa111"]);
    }
  );

  it("matches pool address regardless of 0X vs 0x prefix casing", () => {
    const addresses = getScreenedAddresses(
      sampleTransaction([
        "0x1",
        "0XABC",
        "0xselector",
        "0x6",
        USER_ADDR,
        PRIVATE_KEY,
        "0x1",
        "0x5",
        TOKEN,
        AMOUNT,
      ]),
      "0xabc"
    );
    expect(addresses).toEqual(["0xaaa111"]);
  });

  describe("deposit-only screening", () => {
    it("returns empty when actions contain only SetViewingKey (variant 0)", () => {
      const addresses = getScreenedAddresses(
        sampleTransaction([
          "0x1",
          POOL_ADDR,
          "0xsel",
          "0x5",
          USER_ADDR,
          PRIVATE_KEY,
          "0x1", // 1 action
          "0x0", // SetViewingKey
          "0xabc", // random
        ]),
        POOL_ADDR
      );
      expect(addresses).toEqual([]);
    });

    it("returns empty when actions contain only Withdraw (variant 7)", () => {
      const addresses = getScreenedAddresses(
        sampleTransaction([
          "0x1",
          POOL_ADDR,
          "0xsel",
          "0x8",
          USER_ADDR,
          PRIVATE_KEY,
          "0x1", // 1 action
          "0x7", // Withdraw
          "0x111", // to_addr
          TOKEN,
          AMOUNT,
          "0xabc", // random
        ]),
        POOL_ADDR
      );
      expect(addresses).toEqual([]);
    });

    it("returns address when deposit appears after other actions", () => {
      const addresses = getScreenedAddresses(
        sampleTransaction([
          "0x1",
          POOL_ADDR,
          "0xsel",
          "0x8",
          USER_ADDR,
          PRIVATE_KEY,
          "0x2", // 2 actions
          "0x0", // SetViewingKey
          "0xabc",
          "0x5", // Deposit
          TOKEN,
          AMOUNT,
        ]),
        POOL_ADDR
      );
      expect(addresses).toEqual(["0xaaa111"]);
    });

    it("handles InvokeExternal before deposit", () => {
      const addresses = getScreenedAddresses(
        sampleTransaction([
          "0x1",
          POOL_ADDR,
          "0xsel",
          "0xc",
          USER_ADDR,
          PRIVATE_KEY,
          "0x2", // 2 actions
          "0x8", // InvokeExternal
          "0x222", // contract_address
          "0x2",
          "0xa",
          "0xb", // Span<felt252> len=2
          "0x5", // Deposit
          TOKEN,
          AMOUNT,
        ]),
        POOL_ADDR
      );
      expect(addresses).toEqual(["0xaaa111"]);
    });

    it("returns empty when action count is zero", () => {
      const addresses = getScreenedAddresses(
        sampleTransaction([
          "0x1",
          POOL_ADDR,
          "0xsel",
          "0x3",
          USER_ADDR,
          PRIVATE_KEY,
          "0x0", // 0 actions
        ]),
        POOL_ADDR
      );
      expect(addresses).toEqual([]);
    });

    it("returns empty on malformed calldata (fail-open)", () => {
      const addresses = getScreenedAddresses(
        sampleTransaction([
          "0x1",
          POOL_ADDR,
          "0xsel",
          "0x4",
          USER_ADDR,
          PRIVATE_KEY,
          "0x1", // 1 action
          "0xff", // invalid variant index
        ]),
        POOL_ADDR
      );
      expect(addresses).toEqual([]);
    });
  });
});

// Helper to start a mock elliptic-proxy
let mockServer: Server;
let mockPort: number;

function startMockEllipticProxy(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ) => void
): Promise<void> {
  return new Promise((resolve) => {
    mockServer = createServer(handler);
    mockServer.listen(0, "127.0.0.1", () => {
      const addr = mockServer.address();
      mockPort = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve();
    });
  });
}

afterEach(async () => {
  if (mockServer) {
    await new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    });
  }
});

function makeConfig(overrides?: Partial<ScreeningConfig>): ScreeningConfig {
  return {
    ellipticProxyUrl: `http://127.0.0.1:${mockPort}`,
    partnerName: "test-partner",
    partnerSecret: Buffer.from("test-secret").toString("base64"),
    timeoutMs: 5000,
    failOpen: false,
    maxRetries: 0,
    totalTimeoutMs: 10000,
    poolAddress: POOL_ADDR,
    blockNonPoolTx: false,
    ...overrides,
  };
}

describe("isSinglePoolCall", () => {
  it("returns true for a single-call INVOKE targeting the pool", () => {
    expect(isSinglePoolCall(sampleTransaction(), POOL_ADDR)).toBe(true);
  });

  it("returns false when the target contract is not the pool", () => {
    expect(isSinglePoolCall(sampleTransaction(), "0xother")).toBe(false);
  });

  it("returns false for multi-call transactions", () => {
    const transaction = sampleTransaction([
      "0x2", // 2 calls
      POOL_ADDR,
      "0xsel",
      "0x0",
      "0xother",
      "0xsel",
      "0x0",
    ]);
    expect(isSinglePoolCall(transaction, POOL_ADDR)).toBe(false);
  });

  it("returns false for short calldata", () => {
    expect(
      isSinglePoolCall(
        sampleTransaction(["0x1", POOL_ADDR, "0xsel"]),
        POOL_ADDR
      )
    ).toBe(false);
  });

  it.each([["0X1"], ["0x01"], ["0x001"]])(
    "returns true when call_count is %s (normalized to 0x1)",
    (callCount) => {
      const transaction = sampleTransaction([
        callCount,
        POOL_ADDR,
        "0xsel",
        "0x6",
        USER_ADDR,
        PRIVATE_KEY,
        "0x1",
        "0x5",
        TOKEN,
        AMOUNT,
      ]);
      expect(isSinglePoolCall(transaction, POOL_ADDR)).toBe(true);
    }
  );
});

describe("ScreeningInterceptor", () => {
  it("returns continue when elliptic-proxy says not blocked", async () => {
    await startMockEllipticProxy((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ blocked: false }));
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig());
    const verdict = await interceptor.intercept(sampleTransaction());
    expect(verdict).toEqual({ action: "allow" });

    const logCall = logSpy.mock.calls.find((call) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.screening === "complete";
    });
    expect(logCall).toBeDefined();
    const logData = JSON.parse(logCall![0] as string);
    expect(logData.result).toBe("allowed");
    expect(logData.attempts).toBe(1);
    expect(typeof logData.screeningLatencyMs).toBe("number");
    logSpy.mockRestore();
  });

  it("returns stop when elliptic-proxy says blocked", async () => {
    await startMockEllipticProxy((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ blocked: true }));
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig());
    const verdict = await interceptor.intercept(sampleTransaction());
    expect(verdict.action).toBe("block");
    if (verdict.action === "block") {
      expect(verdict.reason).toContain("0xaaa111");
    }

    const logCall = logSpy.mock.calls.find((call) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.screening === "complete";
    });
    expect(logCall).toBeDefined();
    const logData = JSON.parse(logCall![0] as string);
    expect(logData.result).toBe("blocked");
    logSpy.mockRestore();
  });

  it("sends correct HMAC-signed request", async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    let receivedBody = "";

    await startMockEllipticProxy(async (req, res) => {
      receivedHeaders = req.headers;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      receivedBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ blocked: false }));
    });

    const config = makeConfig();
    const interceptor = new ScreeningInterceptor(config);
    await interceptor.intercept(sampleTransaction());

    expect(receivedHeaders["x-access-key"]).toBe("test-partner");
    expect(receivedHeaders["x-access-sign"]).toBeDefined();
    expect(receivedHeaders["x-access-timestamp"]).toBeDefined();
    expect(JSON.parse(receivedBody)).toEqual({ address: "0xaaa111" });

    // Verify the HMAC signature is correct
    const timestamp = receivedHeaders["x-access-timestamp"] as string;
    const hmac = createHmac(
      "sha256",
      Buffer.from(config.partnerSecret, "base64")
    );
    hmac.update(timestamp);
    hmac.update("POST");
    hmac.update("/screen");
    hmac.update(receivedBody);
    expect(receivedHeaders["x-access-sign"]).toBe(hmac.digest("base64"));
  });

  it("returns stop with unavailable reason on network error (fail-closed)", async () => {
    const config = makeConfig({
      ellipticProxyUrl: "http://127.0.0.1:1",
      timeoutMs: 1000,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(config);
    const verdict = await interceptor.intercept(sampleTransaction());
    expect(verdict.action).toBe("block");
    if (verdict.action === "block") {
      expect(verdict.reason).toContain("screening unavailable");
    }

    const errorCall = errorSpy.mock.calls.find((call) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.error === "screening_failed";
    });
    expect(errorCall).toBeDefined();
    expect(JSON.parse(errorCall![0] as string).attempts).toBe(1);
    errorSpy.mockRestore();
  });

  it("returns continue on network error when fail-open", async () => {
    const config = makeConfig({
      ellipticProxyUrl: "http://127.0.0.1:1",
      timeoutMs: 1000,
      failOpen: true,
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(config);
    const verdict = await interceptor.intercept(sampleTransaction());
    expect(verdict).toEqual({ action: "allow" });
    spy.mockRestore();
  });

  it("returns stop with unavailable reason on non-200 response (fail-closed)", async () => {
    await startMockEllipticProxy((_req, res) => {
      res.writeHead(500);
      res.end("internal error");
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig());
    const verdict = await interceptor.intercept(sampleTransaction());
    expect(verdict.action).toBe("block");
    if (verdict.action === "block") {
      expect(verdict.reason).toContain("screening unavailable");
    }
    spy.mockRestore();
  });

  it("retries on failure", async () => {
    let requestCount = 0;
    await startMockEllipticProxy((_req, res) => {
      requestCount++;
      if (requestCount < 3) {
        res.writeHead(500);
        res.end("error");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ blocked: false }));
      }
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig({ maxRetries: 2 }));
    const verdict = await interceptor.intercept(sampleTransaction());
    expect(verdict).toEqual({ action: "allow" });
    expect(requestCount).toBe(3);

    const logCall = logSpy.mock.calls.find((call) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.screening === "complete";
    });
    expect(logCall).toBeDefined();
    expect(JSON.parse(logCall![0] as string).attempts).toBe(3);
    logSpy.mockRestore();
  });

  it("continues when calldata has no extractable address", async () => {
    const transaction = sampleTransaction(["0x0"]);
    const interceptor = new ScreeningInterceptor(
      makeConfig({ ellipticProxyUrl: "http://127.0.0.1:1" })
    );
    const verdict = await interceptor.intercept(transaction);
    expect(verdict).toEqual({ action: "allow" });
  });

  it("allows transactions whose contract address does not match the pool", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(
      makeConfig({
        ellipticProxyUrl: "http://127.0.0.1:1",
        poolAddress: "0xdifferent",
      })
    );
    const verdict = await interceptor.intercept(sampleTransaction());
    expect(verdict).toEqual({ action: "allow" });

    const logEntry = findLogEntry(
      logSpy,
      (entry) => entry.screening === "non_pool_tx"
    );
    expect(logEntry).toEqual({
      screening: "non_pool_tx",
      action: "allow",
      blockNonPoolTx: false,
    });
    logSpy.mockRestore();
  });

  describe("blockNonPoolTx flag", () => {
    it("blocks transactions whose target is not the pool", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const interceptor = new ScreeningInterceptor(
        makeConfig({
          ellipticProxyUrl: "http://127.0.0.1:1",
          poolAddress: "0xdifferent",
          blockNonPoolTx: true,
        })
      );
      const verdict = await interceptor.intercept(sampleTransaction());
      expect(verdict.action).toBe("block");
      if (verdict.action === "block") {
        expect(verdict.reason).toContain(
          "not a direct call to the privacy pool"
        );
      }

      const logEntry = findLogEntry(
        logSpy,
        (entry) => entry.screening === "non_pool_tx"
      );
      expect(logEntry).toEqual({
        screening: "non_pool_tx",
        action: "block",
        blockNonPoolTx: true,
      });
      logSpy.mockRestore();
    });

    it("blocks multi-call transactions even if a call targets the pool", async () => {
      const transaction = sampleTransaction([
        "0x2", // 2 calls
        POOL_ADDR,
        "0xsel",
        "0x0",
        "0xother",
        "0xsel",
        "0x0",
      ]);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const interceptor = new ScreeningInterceptor(
        makeConfig({
          ellipticProxyUrl: "http://127.0.0.1:1",
          blockNonPoolTx: true,
        })
      );
      const verdict = await interceptor.intercept(transaction);
      expect(verdict.action).toBe("block");

      const logEntry = findLogEntry(
        logSpy,
        (entry) => entry.screening === "non_pool_tx"
      );
      expect(logEntry?.action).toBe("block");
      logSpy.mockRestore();
    });

    it("still screens single-call pool deposits when flag is set", async () => {
      await startMockEllipticProxy((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ blocked: false }));
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const interceptor = new ScreeningInterceptor(
        makeConfig({ blockNonPoolTx: true })
      );
      const verdict = await interceptor.intercept(sampleTransaction());
      expect(verdict).toEqual({ action: "allow" });

      // Pool deposits should not emit the "non_pool_tx" log line — they go
      // through the screening path instead.
      const nonPoolLog = findLogEntry(
        logSpy,
        (entry) => entry.screening === "non_pool_tx"
      );
      expect(nonPoolLog).toBeUndefined();
      logSpy.mockRestore();
    });
  });
});

function findLogEntry(
  logSpy: ReturnType<typeof vi.spyOn<typeof console, "log">>,
  predicate: (entry: Record<string, unknown>) => boolean
): Record<string, unknown> | undefined {
  for (const call of logSpy.mock.calls) {
    try {
      const parsed = JSON.parse(call[0] as string) as Record<string, unknown>;
      if (predicate(parsed)) return parsed;
    } catch {
      // not JSON, skip
    }
  }
  return undefined;
}
