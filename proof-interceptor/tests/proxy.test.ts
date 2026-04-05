// tests/proxy.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHandler, type HandlerOptions } from "../src/proxy.js";
import type { TransactionInterceptor } from "../src/interceptor.js";

let proxy: Server;
let proxyPort: number;

function startProxy(options?: Partial<HandlerOptions>): Promise<void> {
  return new Promise((resolve) => {
    const handler = createHandler(options);
    proxy = createServer(handler);
    proxy.listen(0, "127.0.0.1", () => {
      const addr = proxy.address();
      proxyPort = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve();
    });
  });
}

function proxyUrl(path: string): string {
  return `http://127.0.0.1:${proxyPort}${path}`;
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
    if (!proxy) return resolve();
    proxy.close(() => resolve());
  });
});

describe("handler", () => {
  it("responds to /health with 200", async () => {
    await startProxy();

    const response = await fetch(proxyUrl("/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns JSON-RPC error for unknown method", async () => {
    await startProxy();

    const response = await rpcPost(proxyUrl("/"), {
      jsonrpc: "2.0",
      id: 1,
      method: "unknown_method",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.error.code).toBe(-32601);
  });

  it("returns 400 for non-JSON POST body", async () => {
    await startProxy();

    const response = await fetch(proxyUrl("/"), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "raw data",
    });

    expect(response.status).toBe(400);
  });

  it("returns 400 for non-POST request", async () => {
    await startProxy();

    const response = await fetch(proxyUrl("/some/path"));
    expect(response.status).toBe(400);
  });

  it("returns 413 when body exceeds maxBodyBytes", async () => {
    await startProxy({ maxBodyBytes: 10 });

    const response = await fetch(proxyUrl("/"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(100) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload too large" });
  });

  it("returns specVersion result for starknet_specVersion", async () => {
    await startProxy();

    const response = await rpcPost(proxyUrl("/"), {
      jsonrpc: "2.0",
      id: 1,
      method: "starknet_specVersion",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toBe("0.10.1");
  });
});

describe("handler with interceptors", () => {
  it("returns allowed result when interceptor allows", async () => {
    const allowAll: TransactionInterceptor = {
      name: "allow-all",
      intercept: async () => ({ action: "allow" }),
    };
    await startProxy({ interceptors: [allowAll] });

    const response = await rpcPost(proxyUrl("/"), checkRequest());
    const body = await response.json();
    expect(body.result).toEqual({ allowed: true });
    expect(body.id).toBe(1);
  });

  it("returns 10000 when interceptor blocks", async () => {
    const blocker: TransactionInterceptor = {
      name: "blocker",
      intercept: async () => ({ action: "block", reason: "sanctioned" }),
    };
    await startProxy({ interceptors: [blocker] });

    const response = await rpcPost(proxyUrl("/"), checkRequest());
    const body = await response.json();
    expect(body.error.code).toBe(10000);
    expect(body.error.message).toBe("Transaction rejected");
    expect(body.error.data).toBe("sanctioned");
    expect(body.id).toBe(1);
  });

  it("does not run interceptors for starknet_specVersion", async () => {
    let interceptorCalled = false;
    const spy: TransactionInterceptor = {
      name: "spy",
      intercept: async () => {
        interceptorCalled = true;
        return { action: "block", reason: "should not be called" };
      },
    };
    await startProxy({ interceptors: [spy] });

    const response = await rpcPost(proxyUrl("/"), {
      jsonrpc: "2.0",
      id: 1,
      method: "starknet_specVersion",
    });
    const body = await response.json();
    expect(body.result).toBe("0.10.1");
    expect(interceptorCalled).toBe(false);
  });

  it("returns 10000 when interceptor throws", async () => {
    const thrower: TransactionInterceptor = {
      name: "thrower",
      intercept: async () => {
        throw new Error("network timeout");
      },
    };
    await startProxy({ interceptors: [thrower] });

    const response = await rpcPost(proxyUrl("/"), checkRequest());
    const body = await response.json();
    expect(body.error.code).toBe(10000);
    expect(body.error.data).toBe("network timeout");
  });

  it("returns allowed result with no interceptors configured", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await startProxy();

    const response = await rpcPost(proxyUrl("/"), checkRequest());
    const body = await response.json();
    expect(body.result).toEqual({ allowed: true });
    spy.mockRestore();
  });
});
