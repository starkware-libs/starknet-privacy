// tests/proxy.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createProxyHandler, type ProxyOptions } from "../src/proxy.js";

let upstream: Server;
let upstreamPort: number;
let proxy: Server;
let proxyPort: number;

function startUpstream(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ) => void
): Promise<void> {
  return new Promise((resolve) => {
    upstream = createServer(handler);
    upstream.listen(0, "127.0.0.1", () => {
      const addr = upstream.address();
      upstreamPort = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve();
    });
  });
}

function startProxy(
  upstreamUrl: string,
  options?: Partial<ProxyOptions>
): Promise<void> {
  return new Promise((resolve) => {
    const handler = createProxyHandler(upstreamUrl, {
      forwardUnknownMethods: false,
      ...options,
    });
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

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!proxy) return resolve();
    proxy.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    if (!upstream) return resolve();
    upstream.close(() => resolve());
  });
});

describe("proxy", () => {
  it("forwards GET request and returns upstream response", async () => {
    await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hello: "world" }));
    });
    await startProxy(`http://127.0.0.1:${upstreamPort}`);

    const response = await fetch(proxyUrl("/some/path"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hello: "world" });
  });

  it("forwards non-JSON POST body to upstream", async () => {
    let receivedBody = "";
    await startUpstream(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      receivedBody = Buffer.concat(chunks).toString();
      res.writeHead(200);
      res.end("ok");
    });
    await startProxy(`http://127.0.0.1:${upstreamPort}`);

    const response = await fetch(proxyUrl("/"), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "raw data",
    });

    expect(response.status).toBe(200);
    expect(receivedBody).toBe("raw data");
  });

  it("forwards valid JSON-RPC request to upstream", async () => {
    let receivedBody = "";
    await startUpstream(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      receivedBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0.10.1" }));
    });
    await startProxy(`http://127.0.0.1:${upstreamPort}`);

    const rpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "starknet_specVersion",
    };
    const response = await fetch(proxyUrl("/"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcRequest),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toBe("0.10.1");
    // Verify upstream received the original request
    expect(JSON.parse(receivedBody)).toEqual(rpcRequest);
  });

  it("returns JSON-RPC error for unknown method without forwarding", async () => {
    await startProxy("http://127.0.0.1:1"); // upstream doesn't matter

    const response = await fetch(proxyUrl("/"), {
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

  it("forwards request headers (excluding hop-by-hop)", async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    await startUpstream((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end("ok");
    });
    await startProxy(`http://127.0.0.1:${upstreamPort}`);

    await fetch(proxyUrl("/"), {
      headers: { "x-custom": "value", "content-type": "text/plain" },
    });

    expect(receivedHeaders["x-custom"]).toBe("value");
    expect(receivedHeaders["content-type"]).toBe("text/plain");
    expect(receivedHeaders["host"]).not.toContain(String(proxyPort));
  });

  it("forwards upstream error status codes", async () => {
    await startUpstream((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    });
    await startProxy(`http://127.0.0.1:${upstreamPort}`);

    const response = await fetch(proxyUrl("/"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
  });

  it("returns 502 when upstream is unreachable", async () => {
    await startProxy("http://127.0.0.1:1");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await fetch(proxyUrl("/"));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "bad gateway" });
    spy.mockRestore();
  });

  it("responds to /health with 200", async () => {
    await startProxy("http://127.0.0.1:1");

    const response = await fetch(proxyUrl("/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("preserves upstream URL path", async () => {
    let receivedUrl = "";
    await startUpstream((req, res) => {
      receivedUrl = req.url ?? "";
      res.writeHead(200);
      res.end("ok");
    });
    await startProxy(`http://127.0.0.1:${upstreamPort}`);

    await fetch(proxyUrl("/api/v1/resource?key=value"));
    expect(receivedUrl).toBe("/api/v1/resource?key=value");
  });

  it("returns 413 when request body exceeds maxBodyBytes", async () => {
    await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await startProxy(`http://127.0.0.1:${upstreamPort}`, { maxBodyBytes: 10 });

    const response = await fetch(proxyUrl("/"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "this body is definitely longer than ten bytes" }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload too large" });
  });
});
