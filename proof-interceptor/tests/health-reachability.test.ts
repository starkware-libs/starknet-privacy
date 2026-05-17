// tests/health-reachability.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createHandler } from "../src/proxy.js";
import {
  ScreeningInterceptor,
  type ScreeningConfig,
} from "../src/screening-interceptor.js";

const POOL_ADDR = "0xpool";
const USER_ADDR = "0xaaa111";
const PRIVATE_KEY = "0xbbb222";
const TOKEN = "0xdead";
const AMOUNT = "0x64";

interface ProveTxn {
  type: "INVOKE";
  version: "0x3";
  sender_address: string;
  calldata: string[];
  signature: string[];
  nonce: string;
  resource_bounds: Record<string, unknown>;
  tip: string;
  paymaster_data: string[];
  account_deployment_data: string[];
  nonce_data_availability_mode: string;
  fee_data_availability_mode: string;
}

function sampleTransaction(): ProveTxn {
  return {
    type: "INVOKE",
    version: "0x3",
    sender_address: "0xcontract",
    calldata: [
      "0x1",
      POOL_ADDR,
      "0xselector",
      "0x6",
      USER_ADDR,
      PRIVATE_KEY,
      "0x1",
      "0x5",
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
  };
}

function makeConfig(overrides: Partial<ScreeningConfig> = {}): ScreeningConfig {
  return {
    ellipticProxyUrl: "http://127.0.0.1:1",
    partnerName: "test-partner",
    partnerSecret: Buffer.from("secret").toString("base64"),
    timeoutMs: 200,
    failOpen: false,
    maxRetries: 0,
    totalTimeoutMs: 500,
    poolAddress: POOL_ADDR,
    blockNonPoolTx: false,
    healthMaxUnavailableMs: 50,
    ...overrides,
  };
}

let upstream: Server | undefined;
let interceptorServer: Server | undefined;

afterEach(async () => {
  for (const s of [upstream, interceptorServer]) {
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  upstream = undefined;
  interceptorServer = undefined;
});

function startServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ) => void
): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ port, server });
    });
  });
}

describe("ScreeningInterceptor.health()", () => {
  it("starts healthy when no calls have been made yet", () => {
    const interceptor = new ScreeningInterceptor(makeConfig());
    expect(interceptor.health()).toEqual({ healthy: true });
  });

  it("remains healthy when failOpen is true even after failures", async () => {
    const interceptor = new ScreeningInterceptor(
      makeConfig({ failOpen: true, ellipticProxyUrl: "http://127.0.0.1:1" })
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await interceptor.intercept(sampleTransaction());
    // wait past the unavailability window
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(interceptor.health()).toEqual({ healthy: true });
    errSpy.mockRestore();
  });

  it("reports unhealthy when failures span the window and failOpen is false", async () => {
    const interceptor = new ScreeningInterceptor(
      makeConfig({
        failOpen: false,
        ellipticProxyUrl: "http://127.0.0.1:1",
        healthMaxUnavailableMs: 30,
      })
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await interceptor.intercept(sampleTransaction());
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(interceptor.health()).toMatchObject({
      healthy: false,
      reason: "screening_unreachable",
    });
    errSpy.mockRestore();
  });

  it("returns to healthy after a successful screening call", async () => {
    const { port } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ blocked: false }));
      });
    });
    upstream = (await startServer(() => {})).server;
    upstream.close();
    const interceptor = new ScreeningInterceptor(
      makeConfig({
        ellipticProxyUrl: `http://127.0.0.1:${port}`,
        healthMaxUnavailableMs: 10,
      })
    );
    await interceptor.intercept(sampleTransaction());
    expect(interceptor.health()).toEqual({ healthy: true });
  });
});

describe("/health endpoint reflects interceptor health", () => {
  it("returns 503 with unhealthy interceptor name when screening is unreachable", async () => {
    const interceptor = new ScreeningInterceptor(
      makeConfig({
        failOpen: false,
        ellipticProxyUrl: "http://127.0.0.1:1",
        healthMaxUnavailableMs: 20,
      })
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await interceptor.intercept(sampleTransaction());
    await new Promise((resolve) => setTimeout(resolve, 40));
    errSpy.mockRestore();

    const handler = createHandler({ interceptors: [interceptor] });
    const { port, server } = await startServer(handler);
    interceptorServer = server;

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      status: string;
      interceptors: Array<{ name: string; reason?: string }>;
    };
    expect(body.status).toBe("unhealthy");
    expect(body.interceptors).toEqual([
      { name: "screening", reason: "screening_unreachable" },
    ]);
  });

  it("returns 200 when no interceptors are registered", async () => {
    const handler = createHandler({ interceptors: [] });
    const { port, server } = await startServer(handler);
    interceptorServer = server;

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("/health body does not include internal timestamps or counters", async () => {
    const interceptor = new ScreeningInterceptor(
      makeConfig({
        failOpen: false,
        ellipticProxyUrl: "http://127.0.0.1:1",
        healthMaxUnavailableMs: 20,
      })
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await interceptor.intercept(sampleTransaction());
    await new Promise((resolve) => setTimeout(resolve, 40));
    errSpy.mockRestore();

    const handler = createHandler({ interceptors: [interceptor] });
    const { port, server } = await startServer(handler);
    interceptorServer = server;

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const raw = await response.text();
    // No timestamps, no error counts, no upstream URL — only the opaque
    // shape declared by InterceptorHealth.
    expect(raw).not.toMatch(/consecutiveFailure/);
    expect(raw).not.toMatch(/[0-9]{10}/); // millis-since-epoch timestamps
    expect(raw).not.toContain("127.0.0.1");
  });
});
