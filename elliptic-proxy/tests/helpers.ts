// tests/helpers.ts
//
// Shared fixtures for the handler-level suites: a valid config, a
// partner-signed /screen request, and a capturing response stub.
import type { Request, Response } from "@google-cloud/functions-framework";
import { computeHmacSignature } from "../src/auth.js";
import type { Config } from "../src/config.js";

export const PARTNER_SECRET = Buffer.from("partner-secret").toString("base64");

export function makeConfig(overrides: Partial<Config> = {}): Config {
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
    ...overrides,
  };
}

export function makeRequest(
  overrides: Record<string, unknown> = {},
  address = "0xabc123"
): Request {
  const body = JSON.stringify({ address });
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
    body: { address },
    ...overrides,
  } as unknown as Request;
}

export function makeResponse(): Response & {
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
