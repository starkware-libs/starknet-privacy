import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OhttpClient } from "../../src/internal/ohttp-client.js";

// Mock ohttp-ts and hpke — OhttpClient imports them at module level.
// We provide minimal stubs so ensureClient() and encapsulateRequest() succeed.
vi.mock("ohttp-ts", () => {
  class MockOHTTPClient {
    encapsulateRequest = vi.fn().mockResolvedValue({
      init: {
        method: "POST",
        headers: { "Content-Type": "message/ohttp-req" },
        body: new Uint8Array(),
      },
      context: {
        decapsulateResponse: vi.fn().mockResolvedValue({
          status: 200,
          text: () => Promise.resolve('{"ok":true}'),
        }),
      },
    });
  }
  return {
    OHTTPClient: MockOHTTPClient,
    KeyConfig: { parseMultiple: vi.fn().mockReturnValue([{}]) },
  };
});
vi.mock("hpke", () => {
  class MockCipherSuite {}
  return {
    CipherSuite: MockCipherSuite,
    KEM_DHKEM_X25519_HKDF_SHA256: 0x20,
    KDF_HKDF_SHA256: 0x01,
    AEAD_AES_128_GCM: 0x01,
  };
});

describe("OhttpClient", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  describe("HTTPS warning (Finding 2)", () => {
    it("warns when gatewayUrl is plain HTTP without pinned key", () => {
      new OhttpClient("http://evil.example.com");
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain("not HTTPS");
    });

    it("does not warn for http://localhost", () => {
      new OhttpClient("http://localhost:8080");
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn for http://127.0.0.1", () => {
      new OhttpClient("http://127.0.0.1:8080");
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn for HTTPS gateway", () => {
      new OhttpClient("https://example.com");
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not warn when publicKeyConfig is pinned", () => {
      new OhttpClient("http://evil.example.com", {
        publicKeyConfig: new Uint8Array([1, 2, 3]),
      });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("outer URL construction (Finding 3)", () => {
    function mockFetch() {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "message/ohttp-res" },
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
      globalThis.fetch = fetchMock;
      return fetchMock;
    }

    it("sends to gatewayUrl without appending path (no relay)", async () => {
      const fetchMock = mockFetch();
      const client = new OhttpClient("https://gw.example.com", {
        publicKeyConfig: new Uint8Array([1]),
      });

      await client.post("/v1/sync/incoming_state", { key: "abc" });

      // First call is the actual OHTTP POST (ensureClient skips fetch with pinned key)
      const postCallUrl = fetchMock.mock.calls[0][0];
      expect(postCallUrl).toBe("https://gw.example.com");
    });

    it("sends to relayUrl without appending path", async () => {
      const fetchMock = mockFetch();
      const client = new OhttpClient("https://gw.example.com", {
        publicKeyConfig: new Uint8Array([1]),
        relayUrl: "https://relay.example.com/ohttp-relay",
      });

      await client.post("/v1/sync/incoming_state", { key: "abc" });

      const postCallUrl = fetchMock.mock.calls[0][0];
      expect(postCallUrl).toBe("https://relay.example.com/ohttp-relay");
    });

    it("uses same outer URL for different inner paths", async () => {
      const fetchMock = mockFetch();
      const client = new OhttpClient("https://gw.example.com", {
        publicKeyConfig: new Uint8Array([1]),
        relayUrl: "https://relay.example.com/ohttp-relay",
      });

      await client.post("/v1/sync/incoming_state", {});
      await client.post("/v1/history", {});

      expect(fetchMock.mock.calls[0][0]).toBe("https://relay.example.com/ohttp-relay");
      expect(fetchMock.mock.calls[1][0]).toBe("https://relay.example.com/ohttp-relay");
    });
  });
});
