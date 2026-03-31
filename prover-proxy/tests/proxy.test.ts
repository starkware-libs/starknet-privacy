// tests/proxy.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createProxyHandler } from "../src/proxy.js";

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

function startProxy(upstreamUrl: string, maxBodyBytes?: number): Promise<void> {
  return new Promise((resolve) => {
    const handler = createProxyHandler(upstreamUrl, maxBodyBytes);
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
    proxy?.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    upstream?.close(() => resolve());
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

  it("forwards POST body to upstream", async () => {
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "test" }),
    });

    expect(response.status).toBe(200);
    expect(receivedBody).toBe('{"data":"test"}');
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
    await startProxy(`http://127.0.0.1:${upstreamPort}`, 10);

    const response = await fetch(proxyUrl("/"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "this body is definitely longer than ten bytes" }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload too large" });
  });
});
