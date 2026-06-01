// tests/e2e.test.ts
//
// End-to-end test: proof-interceptor → elliptic-proxy /screen. A deposit is
// screened and signed in one /screen call; an allowed deposit relays a
// signature, a sanctioned one is rejected with JSON-RPC 10000.
//
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import * as ff from "@google-cloud/functions-framework";
import { getTestServer } from "@google-cloud/functions-framework/testing";
import { createHandler } from "../src/proxy.js";
import { ScreeningInterceptor } from "../src/screening-interceptor.js";

import { createHandler as createEllipticHandler } from "../../elliptic-proxy/src/handler.js";
import { forwardToElliptic } from "../../elliptic-proxy/src/elliptic.js";
import type { Config } from "../../elliptic-proxy/src/config.js";

const PARTNER_NAME = "proof-interceptor";
const PARTNER_SECRET = Buffer.from("e2e-secret").toString("base64");
// SN_MAIN, so the proxy runs the live Elliptic path (against the mock API)
// rather than mock mode.
const CHAIN_ID = "0x534e5f4d41494e";
// Dev signing key (1 <= key < STARK curve order). Test-only.
const SIGNING_KEY =
  "0x03e1f1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddee";
const BLOCKED_ADDRESS = "0xbad0";
// Rule ID for SANCTIONED_ENTITY — the live Elliptic mock returns this for the
// blocked address (the operator deny list is mock-mode only, so live screening
// blocks via the upstream response).
const SANCTIONED_RULE = "1f86dce1-166a-4749-a5df-3972fae7635a";

let mockEllipticApi: Server;
let ellipticProxyServer: Server;
let interceptorServer: Server;

let mockEllipticApiPort: number;
let ellipticProxyPort: number;
let interceptorPort: number;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

let testCounter = 0;

async function startMockEllipticApi(
  responses: Record<string, object>
): Promise<void> {
  mockEllipticApi = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const address = body.subject?.hash ?? "";

    const responseBody = responses[address] ?? cleanEllipticResponse();

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(responseBody));
  });
  mockEllipticApiPort = await listen(mockEllipticApi);
}

async function startEllipticProxy(): Promise<void> {
  const config: Config = {
    elliptic: {
      url: `http://127.0.0.1:${mockEllipticApiPort}`,
      key: "elliptic-api-key",
      secret: Buffer.from("elliptic-api-secret").toString("base64"),
      timeoutMs: 10000,
    },
    rateLimitPerMinute: 100,
    maxBodyBytes: 10240,
    configCacheTtlSeconds: 300,
    blockedCacheTtlSeconds: 300,
    partners: { [PARTNER_NAME]: PARTNER_SECRET },
    // Deposits are screened (live Elliptic, against the mock API) and signed in
    // one /screen call.
    signingPrivateKey: SIGNING_KEY,
    chainId: CHAIN_ID,
  };

  const handler = createEllipticHandler(
    { get: async () => config },
    forwardToElliptic
  );

  // Register with functions-framework and get a test server
  const functionName = `e2e-elliptic-proxy-${++testCounter}`;
  ff.http(functionName, handler);
  ellipticProxyServer = getTestServer(functionName);
  ellipticProxyPort = await listen(ellipticProxyServer);
}

async function startInterceptor(): Promise<void> {
  const interceptor = new ScreeningInterceptor({
    ellipticProxyUrl: `http://127.0.0.1:${ellipticProxyPort}`,
    partnerName: PARTNER_NAME,
    partnerSecret: PARTNER_SECRET,
    timeoutMs: 5000,
    failOpen: false,
    maxRetries: 0,
    totalTimeoutMs: 10000,
    poolAddress: "0xpool",
  });

  const handler = createHandler({ interceptors: [interceptor] });

  interceptorServer = createServer(handler);
  interceptorPort = await listen(interceptorServer);
}

function cleanEllipticResponse(): object {
  return {
    process_status: "complete",
    evaluation_detail: { source: [], destination: [] },
  };
}

function blockedEllipticResponse(): object {
  return {
    process_status: "complete",
    evaluation_detail: {
      source: [
        {
          rule_id: SANCTIONED_RULE,
          risk_score: 10,
          matched_elements: [
            {
              contribution_percentage: 10,
              contribution_value: { usd: 500 },
              counterparty_percentage: 50,
              counterparty_value: { usd: 250 },
            },
          ],
        },
      ],
    },
  };
}

function checkRequest(userAddress: string): object {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "starknet_checkTransaction",
    params: [
      "latest",
      {
        type: "INVOKE",
        version: "0x3",
        sender_address: "0xcontract",
        calldata: [
          "0x1",
          "0xpool",
          "0xselector",
          "0x6",
          userAddress,
          "0xbbb222",
          "0x1",
          "0x5", // Deposit variant
          "0xdead",
          "0x64", // amount
        ],
        signature: ["0x1"],
        nonce: "0x0",
        resource_bounds: {},
        tip: "0x0",
        paymaster_data: [],
        account_deployment_data: [],
        nonce_data_availability_mode: "L1",
        fee_data_availability_mode: "L1",
      },
    ],
  };
}

function rpcPost(port: number, body: object): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  const servers = [interceptorServer, ellipticProxyServer, mockEllipticApi];
  await Promise.all(
    servers
      .filter(Boolean)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

describe("e2e: proof-interceptor → elliptic-proxy /screen", () => {
  it("clean address: allowed, with a screening signature relayed", async () => {
    await startMockEllipticApi({});
    await startEllipticProxy();
    await startInterceptor();

    const response = await rpcPost(interceptorPort, checkRequest("0xc1ea0"));
    const body = await response.json();

    expect(body.result.allowed).toBe(true);
    expect(body.result.additional_data.signature).toMatchObject({
      issued_at: expect.any(Number),
      sig_r: expect.any(String),
      sig_s: expect.any(String),
    });
  }, 15000);

  it("blocked address: rejected with 10000 and an opaque reason", async () => {
    await startMockEllipticApi({
      [BLOCKED_ADDRESS]: blockedEllipticResponse(),
    });
    await startEllipticProxy();
    await startInterceptor();

    const response = await rpcPost(
      interceptorPort,
      checkRequest(BLOCKED_ADDRESS)
    );
    const body = await response.json();

    expect(body.error.code).toBe(10000);
    expect(body.error.message).toBe("Transaction rejected");
    // Opaque reason — must not leak the depositor address.
    expect(body.error.data).toBe("address_blocked");
    expect(body.error.data).not.toContain(BLOCKED_ADDRESS);
  }, 15000);
});
