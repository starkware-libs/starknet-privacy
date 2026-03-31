// tests/elliptic.test.ts
import { describe, it, expect, vi } from "vitest";
import { forwardToElliptic } from "../src/elliptic.js";

// We mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("forwardToElliptic", () => {
  it("builds Elliptic request from address and signs it", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const result = await forwardToElliptic({
      ellipticUrl: "https://api.elliptic.co",
      ellipticKey: "real-key",
      ellipticSecret: Buffer.from("real-secret").toString("base64"),
      ellipticTimeoutMs: 10000,
      address: "0xabc123",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.elliptic.co/v2/wallet/synchronous");
    expect(options.method).toBe("POST");
    expect(options.headers["x-access-key"]).toBe("real-key");
    expect(options.headers["x-access-sign"]).toBeDefined();
    expect(options.headers["x-access-timestamp"]).toBeDefined();

    const sentBody = JSON.parse(options.body);
    expect(sentBody).toEqual({
      subject: {
        asset: "holistic",
        blockchain: "holistic",
        type: "address",
        hash: "0xabc123",
      },
      type: "wallet_exposure",
    });

    expect(result.status).toBe(200);
  });

  it("passes through error responses from Elliptic", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "bad request" }), { status: 400 })
    );

    const result = await forwardToElliptic({
      ellipticUrl: "https://api.elliptic.co",
      ellipticKey: "real-key",
      ellipticSecret: Buffer.from("real-secret").toString("base64"),
      ellipticTimeoutMs: 10000,
      address: "0xbad",
    });

    expect(result.status).toBe(400);
  });
});
