// tests/screening-outcomes.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { ScreeningInterceptor } from "../src/screening-interceptor.js";
import { screeningAvailability, interceptorErrors } from "../src/metrics.js";
import { runInterceptors } from "../src/interceptor.js";

// Match the test calldata layout used by the existing screening tests so the
// ABI decoder sees a real Deposit action and the screening request actually
// goes out — without that, the metric we care about never increments.
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
      "0x1", // 1 call
      POOL_ADDR,
      "0xselector",
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
  };
}

interface AvailabilityOutcomes {
  success: number;
  timeout: number;
  http_error: number;
  network_error: number;
}

async function getAvailability(): Promise<AvailabilityOutcomes> {
  const data = await screeningAvailability.get();
  const out: AvailabilityOutcomes = {
    success: 0,
    timeout: 0,
    http_error: 0,
    network_error: 0,
  };
  for (const sample of data.values) {
    const outcome = sample.labels.outcome as keyof AvailabilityOutcomes;
    if (outcome in out) out[outcome] = sample.value;
  }
  return out;
}

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function makeConfig(
  overrides: Partial<ConstructorParameters<typeof ScreeningInterceptor>[0]> = {}
): ConstructorParameters<typeof ScreeningInterceptor>[0] {
  return {
    ellipticProxyUrl: "http://127.0.0.1:1",
    partnerName: "test-partner",
    partnerSecret: Buffer.from("secret").toString("base64"),
    timeoutMs: 200,
    failOpen: false,
    maxRetries: 0,
    totalTimeoutMs: 1000,
    poolAddress: POOL_ADDR,
    blockNonPoolTx: false,
    ...overrides,
  };
}

function startScreeningServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ) => void
): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

// Suppress noisy stderr from the interceptor's failure log.
function suppressErrorLogs() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("screening availability metric", () => {
  it("labels HTTP 5xx as http_error", async () => {
    const url = await startScreeningServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });

    const interceptor = new ScreeningInterceptor(
      makeConfig({ ellipticProxyUrl: url })
    );
    const errSpy = suppressErrorLogs();
    const before = await getAvailability();

    await interceptor.intercept(sampleTransaction());

    const after = await getAvailability();
    expect(after.http_error - before.http_error).toBe(1);
    expect(after.timeout - before.timeout).toBe(0);
    expect(after.network_error - before.network_error).toBe(0);
    errSpy.mockRestore();
  });

  it("labels a connection refused as network_error", async () => {
    // Port 1 is reserved/refused on all platforms.
    const interceptor = new ScreeningInterceptor(
      makeConfig({ ellipticProxyUrl: "http://127.0.0.1:1" })
    );
    const errSpy = suppressErrorLogs();
    const before = await getAvailability();

    await interceptor.intercept(sampleTransaction());

    const after = await getAvailability();
    expect(after.network_error - before.network_error).toBe(1);
    expect(after.success - before.success).toBe(0);
    errSpy.mockRestore();
  });

  it("labels success when elliptic-proxy returns 2xx", async () => {
    const url = await startScreeningServer((req, res) => {
      // Echo a minimal payload so the interceptor can parse it.
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ blocked: false }));
      });
    });

    const interceptor = new ScreeningInterceptor(
      makeConfig({ ellipticProxyUrl: url })
    );
    const before = await getAvailability();

    await interceptor.intercept(sampleTransaction());

    const after = await getAvailability();
    expect(after.success - before.success).toBe(1);
  });

  it("labels per-call timeout as timeout", async () => {
    const url = await startScreeningServer(() => {
      // never respond — let the client-side AbortSignal fire.
    });

    const interceptor = new ScreeningInterceptor(
      makeConfig({
        ellipticProxyUrl: url,
        timeoutMs: 50,
        totalTimeoutMs: 200,
      })
    );
    const errSpy = suppressErrorLogs();
    const before = await getAvailability();

    await interceptor.intercept(sampleTransaction());

    const after = await getAvailability();
    expect(after.timeout - before.timeout).toBeGreaterThanOrEqual(1);
    errSpy.mockRestore();
  });
});

describe("interceptor_errors_total per-interceptor counter", () => {
  it("attributes a thrown error to the failing interceptor's name", async () => {
    const before =
      (await interceptorErrors.get()).values.find(
        (entry) => entry.labels.interceptor === "thrower"
      )?.value ?? 0;

    const errSpy = suppressErrorLogs();
    await runInterceptors(
      [
        {
          name: "thrower",
          intercept: async () => {
            throw new Error("blow up");
          },
        },
      ],
      sampleTransaction()
    );
    errSpy.mockRestore();

    const after =
      (await interceptorErrors.get()).values.find(
        (entry) => entry.labels.interceptor === "thrower"
      )?.value ?? 0;
    expect(after - before).toBe(1);
  });
});
