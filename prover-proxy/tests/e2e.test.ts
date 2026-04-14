// tests/e2e.test.ts
//
// End-to-end test: prover-proxy → elliptic-proxy → mock Elliptic API
//
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import * as ff from "@google-cloud/functions-framework";
import { getTestServer } from "@google-cloud/functions-framework/testing";
import { createProxyHandler } from "../src/proxy.js";
import { ScreeningInterceptor } from "../src/screening-interceptor.js";

import { createHandler } from "../../elliptic-proxy/src/handler.js";
import { forwardToElliptic } from "../../elliptic-proxy/src/elliptic.js";
import type { Config } from "../../elliptic-proxy/src/config.js";

const PARTNER_NAME = "prover-proxy";
const PARTNER_SECRET = Buffer.from("e2e-secret").toString("base64");

// Rule ID for SANCTIONED_ENTITY
const SANCTIONED_RULE = "1f86dce1-166a-4749-a5df-3972fae7635a";

let mockEllipticApi: Server;
let ellipticProxyServer: Server;
let mockProver: Server;
let proverProxyServer: Server;

let mockEllipticApiPort: number;
let ellipticProxyPort: number;
let mockProverPort: number;
let proverProxyPort: number;

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
  };

  const handler = createHandler({ get: async () => config }, forwardToElliptic);

  // Register with functions-framework and get a test server
  const functionName = `e2e-elliptic-proxy-${++testCounter}`;
  ff.http(functionName, handler);
  ellipticProxyServer = getTestServer(functionName);
  ellipticProxyPort = await listen(ellipticProxyServer);
}

async function startMockProver(): Promise<void> {
  mockProver = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    res.writeHead(200, { "content-type": "application/json" });
    if (body.method === "starknet_specVersion") {
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0.10.1" })
      );
    } else {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            proof: "mock-proof",
            proof_facts: [],
            l2_to_l1_messages: [],
          },
        })
      );
    }
  });
  mockProverPort = await listen(mockProver);
}

async function startProverProxy(): Promise<void> {
  const interceptor = new ScreeningInterceptor({
    ellipticProxyUrl: `http://127.0.0.1:${ellipticProxyPort}`,
    partnerName: PARTNER_NAME,
    partnerSecret: PARTNER_SECRET,
    timeoutMs: 5000,
    failOpen: false,
    maxRetries: 0,
    totalTimeoutMs: 10000,
  });

  const handler = await createProxyHandler(`http://127.0.0.1:${mockProverPort}`, {
    forwardUnknownMethods: false,
    interceptors: [interceptor],
  });

  proverProxyServer = createServer(handler);
  proverProxyPort = await listen(proverProxyServer);
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

function proveRequest(userAddress: string): object {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "starknet_proveTransaction",
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
  const servers = [
    proverProxyServer,
    ellipticProxyServer,
    mockProver,
    mockEllipticApi,
  ];
  await Promise.all(
    servers
      .filter(Boolean)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

describe("e2e: prover-proxy → elliptic-proxy → mock Elliptic API", () => {
  it("clean address: transaction proves successfully", async () => {
    await startMockEllipticApi({});
    await startEllipticProxy();
    await startMockProver();
    await startProverProxy();

    const response = await rpcPost(proverProxyPort, proveRequest("0xc1ea0"));
    const body = await response.json();

    expect(body.result).toEqual({
      proof: "mock-proof",
      proof_facts: [],
      l2_to_l1_messages: [],
    });
  }, 15000);

  it("blocked address: transaction rejected with 10000", async () => {
    await startMockEllipticApi({
      "0xbad0": blockedEllipticResponse(),
    });
    await startEllipticProxy();
    await startMockProver();
    await startProverProxy();

    const response = await rpcPost(proverProxyPort, proveRequest("0xbad0"));
    const body = await response.json();

    expect(body.error.code).toBe(10000);
    expect(body.error.message).toBe("Transaction rejected");
    expect(body.error.data).toContain("0xbad0");
  }, 15000);

  it("starknet_specVersion bypasses screening", async () => {
    await startMockProver();

    const handler = await createProxyHandler(`http://127.0.0.1:${mockProverPort}`, {
      forwardUnknownMethods: false,
      interceptors: [
        new ScreeningInterceptor({
          ellipticProxyUrl: "http://127.0.0.1:1",
          partnerName: PARTNER_NAME,
          partnerSecret: PARTNER_SECRET,
          timeoutMs: 1000,
          failOpen: false,
          maxRetries: 0,
          totalTimeoutMs: 5000,
        }),
      ],
    });

    proverProxyServer = createServer(handler);
    proverProxyPort = await listen(proverProxyServer);

    const response = await rpcPost(proverProxyPort, {
      jsonrpc: "2.0",
      id: 1,
      method: "starknet_specVersion",
    });
    const body = await response.json();
    expect(body.result).toBe("0.10.1");
  });
});
