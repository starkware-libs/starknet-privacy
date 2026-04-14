import { gzipSync, deflateSync } from "node:zlib";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OhttpClient } from "../../src/internal/ohttp-client.js";

// Module-level factory for customizing decapsulateResponse per test.
let decapsulateResponseFactory: () => Promise<unknown>;

function defaultDecapsulateResponse(): Promise<unknown> {
  return Promise.resolve({
    status: 200,
    headers: new Headers(),
    body: null,
    text: () => Promise.resolve('{"ok":true}'),
  });
}

// Mock ohttp-ts and hpke — OhttpClient imports them at module level.
// We provide minimal stubs so ensureClient() and encapsulateRequest() succeed.
vi.mock("ohttp-ts", () => {
  class MockOHTTPClient {
    encapsulateRequest = vi.fn().mockImplementation(async () => ({
      init: {
        method: "POST",
        headers: { "Content-Type": "message/ohttp-req" },
        body: new Uint8Array(),
      },
      context: {
        decapsulateResponse: vi.fn().mockImplementation(() => decapsulateResponseFactory()),
      },
    }));
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
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    decapsulateResponseFactory = defaultDecapsulateResponse;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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

  describe("Content-Encoding decompression", () => {
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

    function makeCompressedResponse(
      jsonData: unknown,
      encoding: string,
      compressFn: (input: Buffer) => Buffer
    ): Response {
      const compressed = compressFn(Buffer.from(JSON.stringify(jsonData)));
      return new Response(new Uint8Array(compressed), {
        status: 200,
        headers: { "Content-Encoding": encoding },
      });
    }

    it("decompresses gzip-encoded inner response", async () => {
      const expected = { proof: "abc123", result: 42 };
      decapsulateResponseFactory = async () => makeCompressedResponse(expected, "gzip", gzipSync);

      mockFetch();
      const client = new OhttpClient("https://gw.example.com", {
        publicKeyConfig: new Uint8Array([1]),
      });

      const result = await client.post("/test", {});
      expect(result).toEqual(expected);
    });

    it("decompresses deflate-encoded inner response", async () => {
      const expected = { data: [1, 2, 3] };
      decapsulateResponseFactory = async () =>
        makeCompressedResponse(expected, "deflate", deflateSync);

      mockFetch();
      const client = new OhttpClient("https://gw.example.com", {
        publicKeyConfig: new Uint8Array([1]),
      });

      const result = await client.post("/test", {});
      expect(result).toEqual(expected);
    });

    it("handles uncompressed response (no Content-Encoding)", async () => {
      // Default factory returns no Content-Encoding — verify backwards compatibility
      mockFetch();
      const client = new OhttpClient("https://gw.example.com", {
        publicKeyConfig: new Uint8Array([1]),
      });

      const result = await client.post("/test", {});
      expect(result).toEqual({ ok: true });
    });

    it("passes through identity Content-Encoding without decompression", async () => {
      const expected = { value: "test" };
      decapsulateResponseFactory = async () =>
        new Response(JSON.stringify(expected), {
          status: 200,
          headers: { "Content-Encoding": "identity" },
        });

      mockFetch();
      const client = new OhttpClient("https://gw.example.com", {
        publicKeyConfig: new Uint8Array([1]),
      });

      const result = await client.post("/test", {});
      expect(result).toEqual(expected);
    });

    it("throws on unsupported Content-Encoding", async () => {
      decapsulateResponseFactory = async () =>
        new Response("compressed-bytes", {
          status: 200,
          headers: { "Content-Encoding": "br" },
        });

      mockFetch();
      const client = new OhttpClient("https://gw.example.com", {
        publicKeyConfig: new Uint8Array([1]),
      });

      await expect(client.post("/test", {})).rejects.toThrow(
        "Unsupported Content-Encoding in OHTTP response: br"
      );
    });
  });
});
