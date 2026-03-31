// tests/auth.test.ts
import { describe, it, expect } from "vitest";
import {
  authenticateRequest,
  computeHmacSignature,
  verifySignature,
} from "../src/auth.js";
import type { Request } from "@google-cloud/functions-framework";
import type { Config } from "../src/config.js";

const TEST_SECRET = Buffer.from("test-secret").toString("base64");

describe("computeHmacSignature", () => {
  it("produces a deterministic base64 signature", () => {
    const signature = computeHmacSignature(
      TEST_SECRET,
      "1700000000000",
      "POST",
      "/v2/wallet/synchronous",
      '{"type":"wallet_exposure"}'
    );
    expect(typeof signature).toBe("string");
    expect(signature.length).toBeGreaterThan(0);

    // Same inputs → same output
    const again = computeHmacSignature(
      TEST_SECRET,
      "1700000000000",
      "POST",
      "/v2/wallet/synchronous",
      '{"type":"wallet_exposure"}'
    );
    expect(signature).toBe(again);
  });

  it("different secret produces different signature", () => {
    const otherSecret = Buffer.from("other-secret").toString("base64");
    const sig1 = computeHmacSignature(
      TEST_SECRET,
      "1700000000000",
      "POST",
      "/v2/wallet/synchronous",
      "{}"
    );
    const sig2 = computeHmacSignature(
      otherSecret,
      "1700000000000",
      "POST",
      "/v2/wallet/synchronous",
      "{}"
    );
    expect(sig1).not.toBe(sig2);
  });
});

describe("verifySignature", () => {
  it("returns true for valid signature", () => {
    const timestamp = "1700000000000";
    const method = "POST";
    const path = "/v2/wallet/synchronous";
    const body = '{"type":"wallet_exposure"}';
    const signature = computeHmacSignature(
      TEST_SECRET,
      timestamp,
      method,
      path,
      body
    );

    expect(
      verifySignature(TEST_SECRET, signature, timestamp, method, path, body)
    ).toBe(true);
  });

  it("returns false for tampered body", () => {
    const timestamp = "1700000000000";
    const method = "POST";
    const path = "/v2/wallet/synchronous";
    const signature = computeHmacSignature(
      TEST_SECRET,
      timestamp,
      method,
      path,
      '{"type":"wallet_exposure"}'
    );

    expect(
      verifySignature(
        TEST_SECRET,
        signature,
        timestamp,
        method,
        path,
        '{"type":"TAMPERED"}'
      )
    ).toBe(false);
  });
});

describe("authenticateRequest timestamp validation", () => {
  const partnerSecret = Buffer.from("partner-secret").toString("base64");
  const config: Config = {
    elliptic: {
      url: "https://api.elliptic.co",
      key: "key",
      secret: "secret",
      timeoutMs: 10000,
    },
    rateLimitPerMinute: 100,
    maxBodyBytes: 10240,
    configCacheTtlSeconds: 300,
    partners: { "test-partner": partnerSecret },
  };

  function makeSignedRequest(timestamp: string): Request {
    const body = JSON.stringify({ address: "0xabc" });
    const signature = computeHmacSignature(
      partnerSecret,
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
      body: { address: "0xabc" },
    } as unknown as Request;
  }

  it("accepts request with current timestamp", () => {
    const result = authenticateRequest(
      makeSignedRequest(Date.now().toString()),
      config
    );
    expect("secret" in result).toBe(true);
  });

  it("rejects request with timestamp older than 5 minutes", () => {
    const staleTimestamp = (Date.now() - 6 * 60 * 1000).toString();
    const result = authenticateRequest(
      makeSignedRequest(staleTimestamp),
      config
    );
    expect("error" in result).toBe(true);
    if ("reason" in result) {
      expect(result.reason).toBe("timestamp_expired");
    }
  });

  it("rejects request with timestamp more than 5 minutes in the future", () => {
    const futureTimestamp = (Date.now() + 6 * 60 * 1000).toString();
    const result = authenticateRequest(
      makeSignedRequest(futureTimestamp),
      config
    );
    expect("error" in result).toBe(true);
    if ("reason" in result) {
      expect(result.reason).toBe("timestamp_expired");
    }
  });

  it("rejects request with non-numeric timestamp", () => {
    const result = authenticateRequest(
      makeSignedRequest("not-a-number"),
      config
    );
    expect("error" in result).toBe(true);
    if ("reason" in result) {
      expect(result.reason).toBe("timestamp_expired");
    }
  });
});
