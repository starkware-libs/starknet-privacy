// tests/proxy.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHandler, type HandlerOptions } from "../src/proxy.js";

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

function sampleInvokeV3(): Record<string, unknown> {
  return {
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
  };
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

  it("returns 413 when request body exceeds maxBodyBytes", async () => {
    await startServer({ maxBodyBytes: 10 });
    const response = await fetch(serverUrl("/"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "this body exceeds ten bytes" }),
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

  it("returns JSON-RPC error for invalid RPC request", async () => {
    await startServer();
    const response = await fetch(serverUrl("/"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "unknown_method",
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.error.code).toBe(-32601);
  });

  it("returns success for valid starknet_checkTransaction", async () => {
    await startServer();
    const response = await fetch(serverUrl("/"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "starknet_checkTransaction",
        params: ["latest", sampleInvokeV3()],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });
});
