// tests/proxy.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHandler, type HandlerOptions } from "../src/proxy.js";
import type { TransactionInterceptor } from "../src/interceptor.js";
import { errorsTotal } from "../src/metrics.js";

async function errorsTotalValue(type: string): Promise<number> {
  const data = await errorsTotal.get();
  const sample = data.values.find((entry) => entry.labels.type === type);
  return sample?.value ?? 0;
}

let proxy: Server;
let proxyPort: number;

function startProxy(options?: Partial<HandlerOptions>): Promise<void> {
  return new Promise((resolve) => {
    const requestHandler = createHandler(options);
    proxy = createServer(requestHandler);
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
  it("returns 400 for non-JSON-RPC requests", async () => {
    await startProxy();

    const response = await fetch(proxyUrl("/some/path"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "only JSON-RPC POST requests are supported",
    });
  });

  it("returns 400 for non-JSON POST body and increments errors_total", async () => {
    await startProxy();

    const before = await errorsTotalValue("invalid_request");
    const response = await fetch(proxyUrl("/"), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "raw data",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "only JSON-RPC POST requests are supported",
    });
    const after = await errorsTotalValue("invalid_request");
    expect(after).toBe(before + 1);
  });

  it("returns JSON-RPC error for unknown method and increments errors_total{method_not_found}", async () => {
    await startProxy();

    const before = await errorsTotalValue("method_not_found");
    const response = await rpcPost(proxyUrl("/"), {
      jsonrpc: "2.0",
      id: 1,
      method: "unknown_method",
    });
    const after = await errorsTotalValue("method_not_found");
    expect(after).toBe(before + 1);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.error.code).toBe(-32601);
  });

  it("responds to /health with 200", async () => {
    await startProxy();

    const response = await fetch(proxyUrl("/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves Prometheus metrics at /metrics", async () => {
    await startProxy();

    const response = await fetch(proxyUrl("/metrics"));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("proof_interceptor_rpc_requests_total");
    expect(body).toContain("proof_interceptor_request_duration_seconds");
    expect(body).toContain("proof_interceptor_in_flight_requests");
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
});

describe("handler with interceptors", () => {
  it("returns allowed:true when interceptor allows", async () => {
    const allowAll: TransactionInterceptor = {
      name: "test",
      intercept: async () => ({ action: "allow" }),
    };
    await startProxy({ interceptors: [allowAll] });

    const response = await rpcPost(proxyUrl("/"), checkRequest());
    const body = await response.json();
    expect(body.result).toEqual({ allowed: true });
    expect(body.id).toBe(1);
  });

  it("returns 10000 when interceptor rejects", async () => {
    const blocker: TransactionInterceptor = {
      name: "test",
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

  it("returns 10000 when interceptor throws", async () => {
    const thrower: TransactionInterceptor = {
      name: "test",
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
    await startProxy({ interceptors: [blocker, observer] });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await rpcPost(proxyUrl("/"), checkRequest());
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
    await startProxy({ interceptors: [observer] });

    await rpcPost(proxyUrl("/"), checkRequest());

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
    await startProxy({ interceptors: [blocker, throwingObserver] });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await rpcPost(proxyUrl("/"), checkRequest());
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
    await startProxy({ interceptors: [nonBlocking] });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await rpcPost(proxyUrl("/"), checkRequest());
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
    await startProxy({ interceptors: [blocking] });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await rpcPost(proxyUrl("/"), checkRequest());
    const body = await response.json();
    spy.mockRestore();

    expect(body.error.code).toBe(10000);
    expect(body.error.data).toBe("critical failure");
  });
});
