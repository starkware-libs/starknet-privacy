// tests/integration.test.ts
import { describe, it, expect, vi } from "vitest";
import { createHandler } from "../src/handler.js";
import { computeHmacSignature } from "../src/auth.js";
import type { Request } from "@google-cloud/functions-framework";
import type { Config } from "../src/config.js";

describe("integration: full request flow", () => {
  it("happy path — valid screen request returns blocked verdict", async () => {
    const partnerSecret = Buffer.from("integration-secret").toString("base64");

    const config: Config = {
      elliptic: {
        url: "https://api.elliptic.co",
        key: "real-key",
        secret: Buffer.from("real-secret").toString("base64"),
        timeoutMs: 10000,
      },
      rateLimitPerMinute: 100,
      maxBodyBytes: 10240,
      configCacheTtlSeconds: 300,
      blockedCacheTtlSeconds: 300,
      partners: { "integration-partner": partnerSecret },
      signingPrivateKey: "0xcafebabe",
      // 'LIVE_TEST' — a dedicated test chain id (Cairo short string).
      chainId: "0x4c4956455f54455354",
    };

    const body = JSON.stringify({ address: "0xabc123" });
    const timestamp = Date.now().toString();
    const signature = computeHmacSignature(
      partnerSecret,
      timestamp,
      "POST",
      "/screen",
      body
    );

    const req = {
      method: "POST",
      path: "/screen",
      headers: {
        "x-access-key": "integration-partner",
        "x-access-sign": signature,
        "x-access-timestamp": timestamp,
      },
      rawBody: Buffer.from(body),
      body: { address: "0xabc123" },
    } as unknown as Request;

    const mockForward = vi.fn().mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        process_status: "complete",
        evaluation_detail: { source: [], destination: [] },
      }),
      durationMs: 0,
    });

    const res = {
      statusCode: 0,
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
      send(b: string) {
        res.body = b;
        return res;
      },
    };

    const handler = createHandler(
      { get: vi.fn().mockResolvedValue(config) },
      mockForward
    );
    await handler(req, res as unknown as Parameters<typeof handler>[1]);

    expect(res.statusCode).toBe(200);
    const allowed = JSON.parse(res.body);
    expect(allowed).toMatchObject({ blocked: false, source: "elliptic" });
    expect(allowed.signature).toBeDefined();
    expect(mockForward).toHaveBeenCalledWith(
      expect.objectContaining({ address: "0xabc123" })
    );
  });
});
