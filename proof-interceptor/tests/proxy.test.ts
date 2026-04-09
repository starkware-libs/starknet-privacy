// tests/proxy.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHandler, type HandlerOptions } from "../src/proxy.js";
import type { TransactionInterceptor } from "../src/interceptor.js";

let handler: Server;
let handlerPort: number;

function startHandler(options?: Partial<HandlerOptions>): Promise<void> {
  return new Promise((resolve) => {
    const requestHandler = createHandler(options);
    handler = createServer(requestHandler);
    handler.listen(0, "127.0.0.1", () => {
      const addr = handler.address();
      handlerPort = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve();
    });
  });
}

function handlerUrl(path: string): string {
  return `http://127.0.0.1:${handlerPort}${path}`;
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
    if (!handler) return resolve();
    handler.close(() => resolve());
  });
});

describe("handler", () => {
  it("returns 400 for non-JSON-RPC requests", async () => {
    await startHandler();

    const response = await fetch(handlerUrl("/some/path"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "only JSON-RPC POST requests are supported",
    });
  });

  it("returns 400 for non-JSON POST body", async () => {
    await startHandler();

    const response = await fetch(handlerUrl("/"), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "raw data",
    });

    expect(response.status).toBe(400);
  });

  it("returns error for starknet_specVersion with static response", async () => {
    await startHandler();

    const rpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "starknet_specVersion",
    };
    const response = await rpcPost(handlerUrl("/"), rpcRequest);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toBeDefined();
    expect(body.id).toBe(1);
  });

  it("returns JSON-RPC error for unknown method", async () => {
    await startHandler();

    const response = await rpcPost(handlerUrl("/"), {
      jsonrpc: "2.0",
      id: 1,
      method: "unknown_method",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.error.code).toBe(-32601);
  });

  it("responds to /health with 200", async () => {
    await startHandler();

    const response = await fetch(handlerUrl("/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves Prometheus metrics at /metrics", async () => {
    await startHandler();

    const response = await fetch(handlerUrl("/metrics"));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("proof_interceptor_rpc_requests_total");
    expect(body).toContain("proof_interceptor_request_duration_seconds");
    expect(body).toContain("proof_interceptor_in_flight_requests");
  });

  it("returns 413 when body exceeds maxBodyBytes", async () => {
    await startHandler({ maxBodyBytes: 10 });

    const response = await fetch(handlerUrl("/"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(100) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload too large" });
  });
});

describe("handler with interceptors", () => {
  it("returns allowed:true when interceptor allows", async () => {
    const allowAll: TransactionInterceptor = {
      name: "test",
      intercept: async () => ({ action: "allow" }),
    };
    await startHandler({ interceptors: [allowAll] });

    const response = await rpcPost(handlerUrl("/"), checkRequest());
    const body = await response.json();
    expect(body.result).toEqual({ allowed: true });
    expect(body.id).toBe(1);
  });

  it("returns 10000 when interceptor rejects", async () => {
    const blocker: TransactionInterceptor = {
      name: "test",
      intercept: async () => ({ action: "block", reason: "sanctioned" }),
    };
    await startHandler({ interceptors: [blocker] });

    const response = await rpcPost(handlerUrl("/"), checkRequest());
    const body = await response.json();
    expect(body.error.code).toBe(10000);
    expect(body.error.message).toBe("Transaction rejected");
    expect(body.error.data).toBe("sanctioned");
    expect(body.id).toBe(1);
  });

  it("does not run interceptors for starknet_specVersion", async () => {
    let interceptorCalled = false;

    const spy: TransactionInterceptor = {
      name: "test",
      intercept: async () => {
        interceptorCalled = true;
        return { action: "block", reason: "should not be called" };
      },
    };
    await startHandler({ interceptors: [spy] });

    const response = await rpcPost(handlerUrl("/"), {
      jsonrpc: "2.0",
      id: 1,
      method: "starknet_specVersion",
    });
    const body = await response.json();
    expect(body.result).toBeDefined();
    expect(interceptorCalled).toBe(false);
  });

  it("returns 10000 when interceptor throws", async () => {
    const thrower: TransactionInterceptor = {
      name: "test",
      intercept: async () => {
        throw new Error("network timeout");
      },
    };
    await startHandler({ interceptors: [thrower] });

    const response = await rpcPost(handlerUrl("/"), checkRequest());
    const body = await response.json();
    expect(body.error.code).toBe(10000);
    expect(body.error.data).toBe("network timeout");
  });

  it("calls error() on interceptors when screening rejects", async () => {
    const errorSpy = vi.fn().mockResolvedValue(undefined);
    const completeSpy = vi.fn();
    const blocker: TransactionInterceptor = {
      name: "blocker",
      intercept: async () => ({ action: "block", reason: "denied" }),
    };
    const observer: TransactionInterceptor = {
      name: "observer",
      intercept: async () => ({ action: "allow" }),
      error: errorSpy,
      complete: completeSpy,
    };
    await startHandler({ interceptors: [blocker, observer] });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await rpcPost(handlerUrl("/"), checkRequest());
    spy.mockRestore();

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toBe(10000);
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("calls complete() on interceptors when all interceptors allow", async () => {
    const errorSpy = vi.fn().mockResolvedValue(undefined);
    const completeSpy = vi.fn();
    const observer: TransactionInterceptor = {
      name: "observer",
      intercept: async () => ({ action: "allow" }),
      error: errorSpy,
      complete: completeSpy,
    };
    await startHandler({ interceptors: [observer] });

    await rpcPost(handlerUrl("/"), checkRequest());

    expect(completeSpy).toHaveBeenCalledOnce();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("handles error() throwing without affecting the client response", async () => {
    const throwingObserver: TransactionInterceptor = {
      name: "throwing-observer",
      intercept: async () => ({ action: "allow" }),
      error: async () => {
        throw new Error("observer crash");
      },
    };
    const blocker: TransactionInterceptor = {
      name: "blocker",
      intercept: async () => ({ action: "block", reason: "blocked" }),
    };
    await startHandler({ interceptors: [blocker, throwingObserver] });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await rpcPost(handlerUrl("/"), checkRequest());
    const body = await response.json();
    spy.mockRestore();

    // Client still receives the rejection
    expect(body.error.code).toBe(10000);
  });

  it("non-blocking interceptor exception does not reject transaction", async () => {
    const nonBlocking: TransactionInterceptor = {
      name: "non-blocking",
      blocking: false,
      intercept: async () => {
        throw new Error("non-critical failure");
      },
    };
    await startHandler({ interceptors: [nonBlocking] });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await rpcPost(handlerUrl("/"), checkRequest());
    const body = await response.json();
    spy.mockRestore();

    // Transaction goes through despite interceptor failure
    expect(body.result).toEqual({ allowed: true });
  });

  it("blocking interceptor exception rejects transaction", async () => {
    const blocking: TransactionInterceptor = {
      name: "blocking",
      blocking: true,
      intercept: async () => {
        throw new Error("critical failure");
      },
    };
    await startHandler({ interceptors: [blocking] });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await rpcPost(handlerUrl("/"), checkRequest());
    const body = await response.json();
    spy.mockRestore();

    expect(body.error.code).toBe(10000);
    expect(body.error.data).toBe("critical failure");
  });
});
