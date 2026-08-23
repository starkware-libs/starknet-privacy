// tests/screening-interceptor.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ScreeningInterceptor,
  type ScreeningConfig,
} from "../src/screening-interceptor.js";
import {
  ANONYMIZER_ADDR,
  POOL_ADDR,
  SWAP_EXECUTOR,
  computeAndInvokeAction,
  createOpenNoteAction,
  depositAction,
  invokeExternalAction,
  poolCallTransaction,
  rawPoolCallTransaction,
} from "./pool-call.js";

// Test addresses and values — must be valid hex for ABI decoding
// A real felt: unlike the placeholders above, this one is serialized into an action and decoded.

// The interceptor relays the /screen signature verbatim without verifying it,
// so a well-shaped (not cryptographically valid) signature is enough here.
const MOCK_SIGNATURE = {
  issued_at: 1716579600,
  sig_r: "0x6e6f63c878a2fdebb3934de2344fbd4bc04ae47b73561f2a5a170cd0c8a0cb",
  sig_s: "0x58a68a71ca79df6cc71d5b4b4813685f590ede2c686b9096fb350f11298429f",
};

// The additive /screen wire shapes the interceptor parses: an allow carries the
// signature alongside { blocked: false }; a block is { blocked: true }.
const ALLOW_RESPONSE = {
  blocked: false,
  source: "skip",
  signature: MOCK_SIGNATURE,
};
const BLOCKED_RESPONSE = { blocked: true, source: "blocklist" };

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
    // Unreachable on purpose: none of these transactions runs an invoke, so no policy is read. A
    // test that reached for one would fail closed instead of silently screening the wrong address.
    rpcUrl: "http://127.0.0.1:1",
    anonymizerAddress: ANONYMIZER_ADDR,
    policyTtlMs: 60_000,
    policyTimeoutMs: 50,
    blockNonPoolTx: false,
    ...overrides,
  };
}

describe("ScreeningInterceptor", () => {
  it("attaches the signature to the verdict on an allowed deposit", async () => {
    await startMockEllipticProxy((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ALLOW_RESPONSE));
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig());
    const verdict = await interceptor.intercept(rawPoolCallTransaction());
    expect(verdict).toEqual({ action: "allow", signature: MOCK_SIGNATURE });

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

  it("blocks with an opaque reason when /screen returns blocked:true (sanctioned)", async () => {
    await startMockEllipticProxy((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(BLOCKED_RESPONSE));
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig());
    const verdict = await interceptor.intercept(rawPoolCallTransaction());
    expect(verdict.action).toBe("block");
    if (verdict.action === "block") {
      // Opaque code — must NOT leak the depositor address.
      expect(verdict.reason).toBe("address_blocked");
      expect(verdict.reason).not.toContain("0xaaa111");
    }

    const logCall = logSpy.mock.calls.find((call) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.screening === "complete";
    });
    expect(logCall).toBeDefined();
    expect(JSON.parse(logCall![0] as string).result).toBe("blocked");
    logSpy.mockRestore();
  });

  it("sends a correctly HMAC-signed /screen request carrying the address", async () => {
    let receivedUrl = "";
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    let receivedBody = "";

    await startMockEllipticProxy(async (req, res) => {
      receivedUrl = req.url ?? "";
      receivedHeaders = req.headers;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      receivedBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ALLOW_RESPONSE));
    });

    const config = makeConfig();
    const interceptor = new ScreeningInterceptor(config);
    await interceptor.intercept(rawPoolCallTransaction());

    expect(receivedUrl).toBe("/screen");
    expect(receivedHeaders["x-access-key"]).toBe("test-partner");
    expect(receivedHeaders["x-access-sign"]).toBeDefined();
    expect(receivedHeaders["x-access-timestamp"]).toBeDefined();
    expect(JSON.parse(receivedBody)).toEqual({ address: "0xaaa111" });

    // Verify the HMAC signature is computed over the /screen path + this body.
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

  it("fails closed on network error (blocks, opaque unavailable reason)", async () => {
    const config = makeConfig({
      ellipticProxyUrl: "http://127.0.0.1:1",
      timeoutMs: 1000,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(config);
    const verdict = await interceptor.intercept(rawPoolCallTransaction());
    expect(verdict.action).toBe("block");
    if (verdict.action === "block") {
      expect(verdict.reason).toBe("screening_unavailable");
    }

    const errorCall = errorSpy.mock.calls.find((call) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.error === "screening_failed";
    });
    expect(errorCall).toBeDefined();
    expect(JSON.parse(errorCall![0] as string).attempts).toBe(1);
    errorSpy.mockRestore();
  });

  it("fails closed even when failOpen is set (a deposit needs a signature)", async () => {
    const config = makeConfig({
      ellipticProxyUrl: "http://127.0.0.1:1",
      timeoutMs: 1000,
      failOpen: true,
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(config);
    const verdict = await interceptor.intercept(rawPoolCallTransaction());
    expect(verdict.action).toBe("block");
    if (verdict.action === "block") {
      expect(verdict.reason).toBe("screening_unavailable");
    }
    spy.mockRestore();
  });

  it("fails closed on a non-2xx response", async () => {
    await startMockEllipticProxy((_req, res) => {
      res.writeHead(500);
      res.end("internal error");
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig());
    const verdict = await interceptor.intercept(rawPoolCallTransaction());
    expect(verdict.action).toBe("block");
    if (verdict.action === "block") {
      expect(verdict.reason).toBe("screening_unavailable");
    }
    spy.mockRestore();
  });

  it("retries a transient failure then attaches the signature", async () => {
    let requestCount = 0;
    await startMockEllipticProxy((_req, res) => {
      requestCount++;
      if (requestCount < 3) {
        res.writeHead(500);
        res.end("error");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(ALLOW_RESPONSE));
      }
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig({ maxRetries: 2 }));
    const verdict = await interceptor.intercept(rawPoolCallTransaction());
    expect(verdict).toEqual({ action: "allow", signature: MOCK_SIGNATURE });
    expect(requestCount).toBe(3);

    const logCall = logSpy.mock.calls.find((call) => {
      const parsed = JSON.parse(call[0] as string);
      return parsed.screening === "complete";
    });
    expect(logCall).toBeDefined();
    expect(JSON.parse(logCall![0] as string).attempts).toBe(3);
    logSpy.mockRestore();
  });

  it("blocks (fail closed) when /screen allows with an incomplete signature", async () => {
    await startMockEllipticProxy((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Allowed, but the signature is missing required felt fields. The
      // interceptor's check is structural only — cryptographic validity (e.g.
      // a wrong signing key) is verified on-chain, not here.
      res.end(JSON.stringify({ blocked: false, signature: { sig_r: "0x1" } }));
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig());
    const verdict = await interceptor.intercept(rawPoolCallTransaction());
    expect(verdict.action).toBe("block");
    if (verdict.action === "block") {
      expect(verdict.reason).toBe("screening_unavailable");
    }
    spy.mockRestore();
  });

  it("blocks (fail closed) when /screen allows without any signature", async () => {
    await startMockEllipticProxy((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // An allow arrived without a signature — a signer
      // misconfiguration; the deposit must not proceed unsigned.
      res.end(JSON.stringify({ blocked: false, source: "skip" }));
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig());
    const verdict = await interceptor.intercept(rawPoolCallTransaction());
    expect(verdict.action).toBe("block");
    if (verdict.action === "block") {
      expect(verdict.reason).toBe("screening_unavailable");
    }
    spy.mockRestore();
  });

  it("blocks (fail closed) when /screen returns a response without a blocked field", async () => {
    await startMockEllipticProxy((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ source: "skip" })); // not a screen response
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig());
    const verdict = await interceptor.intercept(rawPoolCallTransaction());
    expect(verdict.action).toBe("block");
    if (verdict.action === "block") {
      expect(verdict.reason).toBe("screening_unavailable");
    }
    spy.mockRestore();
  });

  it("blocks (fail closed) when an allowed signature is structurally garbage", async () => {
    await startMockEllipticProxy((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // Well-shaped allow, but sig_r is not a hex felt — the tightened guard
      // must reject it rather than relay nonsense to the prover.
      res.end(
        JSON.stringify({
          blocked: false,
          source: "skip",
          signature: { issued_at: 1, sig_r: "not-hex", sig_s: "0x1" },
        })
      );
    });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig());
    const verdict = await interceptor.intercept(rawPoolCallTransaction());
    expect(verdict.action).toBe("block");
    if (verdict.action === "block") {
      expect(verdict.reason).toBe("screening_unavailable");
    }
    spy.mockRestore();
  });

  it("does not retry a terminal block (blocked:true is served once)", async () => {
    let requestCount = 0;
    await startMockEllipticProxy((_req, res) => {
      requestCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(BLOCKED_RESPONSE));
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig({ maxRetries: 2 }));
    const verdict = await interceptor.intercept(rawPoolCallTransaction());
    expect(verdict).toEqual({ action: "block", reason: "address_blocked" });
    // A terminal block short-circuits before the signature check and is never
    // retried, even though maxRetries allows it.
    expect(requestCount).toBe(1);
    logSpy.mockRestore();
  });

  it("retries a transient failure then resolves to a terminal block", async () => {
    let requestCount = 0;
    await startMockEllipticProxy((_req, res) => {
      requestCount++;
      if (requestCount < 3) {
        res.writeHead(500);
        res.end("error");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(BLOCKED_RESPONSE));
      }
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const interceptor = new ScreeningInterceptor(makeConfig({ maxRetries: 2 }));
    const verdict = await interceptor.intercept(rawPoolCallTransaction());
    expect(verdict).toEqual({ action: "block", reason: "address_blocked" });
    expect(requestCount).toBe(3);
    logSpy.mockRestore();
  });

  it("allows (no signature) when there is no extractable deposit address", async () => {
    const transaction = rawPoolCallTransaction(["0x0"]);
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
    const verdict = await interceptor.intercept(rawPoolCallTransaction());
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

  describe("screening subjects beyond the depositor", () => {
    /** A node answering every `starknet_call` with `Delegated`, the anonymizer's production policy. */
    async function startDelegatedPolicyNode(): Promise<{
      url: string;
      close: () => Promise<void>;
    }> {
      const node = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: ["0x2"] })
          );
        });
      });
      await new Promise<void>((resolve) => node.listen(0, resolve));
      const { port } = node.address() as AddressInfo;
      return {
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((resolve) => node.close(() => resolve())),
      };
    }

    it("blocks a transaction putting up two addresses", async () => {
      // A deposit screens its depositor, and the delegated interaction screens its shadow account.
      // The pool takes one attestation per transaction, so this cannot be satisfied and must not be
      // signed.
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const policyNode = await startDelegatedPolicyNode();
      const interceptor = new ScreeningInterceptor(
        makeConfig({ poolAddress: POOL_ADDR, rpcUrl: policyNode.url })
      );

      const verdict = await interceptor.intercept(
        poolCallTransaction([
          depositAction(),
          createOpenNoteAction(),
          computeAndInvokeAction(),
        ])
      );

      expect(verdict.action).toBe("block");
      if (verdict.action === "block") {
        expect(verdict.reason).toBe("multiple_screening_subjects");
      }
      await policyNode.close();
      logSpy.mockRestore();
    });

    it("blocks when an invoke target's policy cannot be read", async () => {
      // `rpcUrl` is unreachable in these tests, so the policy read fails and the flow fails closed
      // rather than guessing the target is exempt.
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const interceptor = new ScreeningInterceptor(
        makeConfig({ poolAddress: POOL_ADDR })
      );
      const verdict = await interceptor.intercept(
        poolCallTransaction([
          createOpenNoteAction(),
          invokeExternalAction(SWAP_EXECUTOR),
        ])
      );

      expect(verdict.action).toBe("block");
      if (verdict.action === "block") {
        expect(verdict.reason).toBe("screening_policy_unavailable");
      }
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });
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
      const verdict = await interceptor.intercept(rawPoolCallTransaction());
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
      const transaction = rawPoolCallTransaction([
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
        res.end(JSON.stringify(ALLOW_RESPONSE));
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const interceptor = new ScreeningInterceptor(
        makeConfig({ blockNonPoolTx: true })
      );
      const verdict = await interceptor.intercept(rawPoolCallTransaction());
      expect(verdict).toEqual({ action: "allow", signature: MOCK_SIGNATURE });

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
