// tests/proxy.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHandler, type HandlerOptions } from "../src/proxy.js";
import type { TransactionInterceptor } from "../src/interceptor.js";

let server: Server;
let serverPort: number;

function startServer(options?: HandlerOptions): Promise<void> {
  return new Promise((resolve) => {
    const handler = createHandler(options);
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      serverPort = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve();
    });
  });
}

function serverUrl(path: string): string {
  return `http://127.0.0.1:${serverPort}${path}`;
}

function checkRequest(): object {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "starknet_checkTransaction",
    params: [
      "latest",
      {
        type: "INVOKE",
        version: "0x3",
        sender_address: "0x123",
        calldata: ["0x1"],
        signature: ["0x2"],
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

function rpcPost(url: string, body: object): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
});

describe("handler", () => {
  it("responds to /health with 200", async () => {
    await startServer();
    const response = await fetch(serverUrl("/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns 413 when body exceeds maxBodyBytes", async () => {
    await startServer({ maxBodyBytes: 10 });
    const response = await fetch(serverUrl("/"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(100) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload too large" });
  });

  it("returns 405 for GET requests to non-health endpoints", async () => {
    await startServer();
    const response = await fetch(serverUrl("/"));
    expect(response.status).toBe(405);
  });

  it("returns 405 for non-JSON POST", async () => {
    await startServer();
    const response = await fetch(serverUrl("/"), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(response.status).toBe(405);
  });

  it("returns JSON-RPC error for unknown method", async () => {
    await startServer();
    const response = await rpcPost(serverUrl("/"), {
      jsonrpc: "2.0",
      id: 1,
      method: "unknown_method",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.error.code).toBe(-32601);
  });

  it("returns success for valid starknet_checkTransaction", async () => {
    await startServer();
    const response = await rpcPost(serverUrl("/"), checkRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });
});

describe("handler with interceptors", () => {
  it("returns success when interceptor allows", async () => {
    const allowAll: TransactionInterceptor = {
      name: "test-allow",
      intercept: async () => ({ action: "allow" }),
    };
    await startServer({ interceptors: [allowAll] });

    const response = await rpcPost(serverUrl("/"), checkRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  it("returns 10000 when interceptor blocks", async () => {
    const blocker: TransactionInterceptor = {
      name: "test-blocker",
      intercept: async () => ({ action: "block", reason: "sanctioned" }),
    };
    await startServer({ interceptors: [blocker] });

    const response = await rpcPost(serverUrl("/"), checkRequest());
    const body = await response.json();
    expect(body.error.code).toBe(10000);
    expect(body.error.message).toBe("Transaction rejected");
    expect(body.error.data).toBe("sanctioned");
    expect(body.id).toBe(1);
  });
});
