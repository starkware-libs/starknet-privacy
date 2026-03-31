// tests/handler.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "@google-cloud/functions-framework";
import { createHandler } from "../src/handler.js";
import { computeHmacSignature } from "../src/auth.js";
import type { Config } from "../src/config.js";

const PARTNER_SECRET = Buffer.from("partner-secret").toString("base64");

function makeConfig(): Config {
  return {
    elliptic: {
      url: "https://api.elliptic.co",
      key: "elliptic-key",
      secret: Buffer.from("elliptic-secret").toString("base64"),
      timeoutMs: 10000,
    },
    rateLimitPerMinute: 100,
    maxBodyBytes: 10240,
    configCacheTtlSeconds: 300,
    blockedCacheTtlSeconds: 300,
    partners: { "test-partner": PARTNER_SECRET },
  };
}

function makeRequest(overrides: Record<string, unknown> = {}): Request {
  const body = JSON.stringify({ address: "0xabc123" });
  const timestamp = Date.now().toString();
  const signature = computeHmacSignature(
    PARTNER_SECRET,
    timestamp,
    "POST",
    "/screen",
    body
  );

  return {
    method: "POST",
    path: "/screen",
    headers: {
      "x-access-key": "test-partner",
      "x-access-sign": signature,
      "x-access-timestamp": timestamp,
    },
    rawBody: Buffer.from(body),
    body: { address: "0xabc123" },
    ...overrides,
  } as unknown as Request;
}

function makeResponse(): Response & {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
} {
  const res = {
    statusCode: 200,
    body: "",
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    set(key: string, value: string) {
      res.headers[key] = value;
      return res;
    },
    send(body: string) {
      res.body = body;
      return res;
    },
  };
  return res as Response & typeof res;
}

describe("createHandler", () => {
  const mockForward = vi.fn();

  beforeEach(() => {
    mockForward.mockReset();
  });

  it("returns 401 when x-access-key is missing", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    const handler = createHandler(configLoader, mockForward);

    const req = makeRequest({ headers: {} });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when partner is unknown", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    const handler = createHandler(configLoader, mockForward);

    const req = makeRequest({
      headers: {
        "x-access-key": "unknown-partner",
        "x-access-sign": "sig",
        "x-access-timestamp": Date.now().toString(),
      },
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when signature is invalid", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    const handler = createHandler(configLoader, mockForward);

    const req = makeRequest({
      headers: {
        "x-access-key": "test-partner",
        "x-access-sign": "bad-signature",
        "x-access-timestamp": Date.now().toString(),
      },
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns 413 when body exceeds maxBodyBytes", async () => {
    const config = makeConfig();
    config.maxBodyBytes = 5;
    const configLoader = { get: vi.fn().mockResolvedValue(config) };
    const handler = createHandler(configLoader, mockForward);

    const body = '{"address":"0xabc123"}';
    const timestamp = Date.now().toString();
    const signature = computeHmacSignature(
      PARTNER_SECRET,
      timestamp,
      "POST",
      "/screen",
      body
    );

    const req = makeRequest({
      headers: {
        "x-access-key": "test-partner",
        "x-access-sign": signature,
        "x-access-timestamp": timestamp,
      },
      rawBody: Buffer.from(body),
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(413);
  });

  it("returns 400 when address is missing", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    const handler = createHandler(configLoader, mockForward);

    const body = JSON.stringify({ notAddress: "foo" });
    const timestamp = Date.now().toString();
    const signature = computeHmacSignature(
      PARTNER_SECRET,
      timestamp,
      "POST",
      "/screen",
      body
    );

    const req = makeRequest({
      headers: {
        "x-access-key": "test-partner",
        "x-access-sign": signature,
        "x-access-timestamp": timestamp,
      },
      rawBody: Buffer.from(body),
      body: { notAddress: "foo" },
    });
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "missing address" });
  });

  it("forwards valid request and returns blocked verdict", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };

    mockForward.mockResolvedValue({
      status: 200,
      body: '{"some":"elliptic-response"}',
      durationMs: 5,
    });

    const handler = createHandler(configLoader, mockForward);
    const req = makeRequest();
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ blocked: true });
    expect(res.headers["content-type"]).toBe("application/json");
    expect(mockForward).toHaveBeenCalledOnce();
    expect(mockForward).toHaveBeenCalledWith(
      expect.objectContaining({ address: "0xabc123" })
    );
  });

  it("returns 503 when forward throws a network error", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    mockForward.mockRejectedValue(new Error("fetch failed"));

    const handler = createHandler(configLoader, mockForward);
    const req = makeRequest();
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "service unavailable" });
  });

  it("returns 502 when Elliptic returns non-2xx", async () => {
    const configLoader = { get: vi.fn().mockResolvedValue(makeConfig()) };
    mockForward.mockResolvedValue({
      status: 500,
      body: '{"error":"internal"}',
      durationMs: 10,
    });

    const handler = createHandler(configLoader, mockForward);
    const req = makeRequest();
    const res = makeResponse();
    await handler(req, res);

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "upstream error" });
  });
});
