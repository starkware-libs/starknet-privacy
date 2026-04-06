// tests/proxy.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHandler } from "../src/proxy.js";

let server: Server;
let serverPort: number;

function startServer(maxBodyBytes?: number): Promise<void> {
  return new Promise((resolve) => {
    const handler = createHandler(maxBodyBytes);
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
    await startServer(10);
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

  it("accepts JSON-RPC POST and echoes body", async () => {
    await startServer();
    const body = { jsonrpc: "2.0", id: 1, method: "test" };
    const response = await fetch(serverUrl("/"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
  });
});
