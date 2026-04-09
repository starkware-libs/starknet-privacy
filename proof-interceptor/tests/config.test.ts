// tests/config.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Remove env vars that would affect tests
    delete process.env.UPSTREAM_URL;
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.MAX_BODY_BYTES;
    delete process.env.TLS_CERT_PATH;
    delete process.env.TLS_KEY_PATH;
    delete process.env.ARCHIVAL_GCS_BUCKET;
    delete process.env.ARCHIVAL_BLOCKING;
  });

  it("loads config from env vars", () => {
    process.env.HOST = "0.0.0.0";
    process.env.PORT = "9090";

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = loadConfig();
    spy.mockRestore();

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9090);
    expect(config.maxBodyBytes).toBe(5 * 1024 * 1024);
    expect(config.tls).toBeUndefined();
  });

  it("uses defaults for host and port", () => {
    delete process.env.HOST;
    delete process.env.PORT;

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = loadConfig();
    spy.mockRestore();

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
  });

  it("loads TLS config when both cert and key are set", () => {
    process.env.TLS_CERT_PATH = "/path/to/cert.pem";
    process.env.TLS_KEY_PATH = "/path/to/key.pem";

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = loadConfig();
    spy.mockRestore();

    expect(config.tls).toEqual({
      certPath: "/path/to/cert.pem",
      keyPath: "/path/to/key.pem",
    });
  });

  it("throws when only TLS_CERT_PATH is set", () => {
    process.env.TLS_CERT_PATH = "/path/to/cert.pem";
    delete process.env.TLS_KEY_PATH;

    expect(() => loadConfig()).toThrow("both be set or both absent");
  });

  it("reads maxBodyBytes from MAX_BODY_BYTES env var", () => {
    process.env.MAX_BODY_BYTES = "1048576";

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = loadConfig();
    spy.mockRestore();

    expect(config.maxBodyBytes).toBe(1048576);
  });

  it("throws when PORT is not a valid integer", () => {
    process.env.PORT = "abc";

    expect(() => loadConfig()).toThrow("PORT must be a valid integer");
  });

  it("throws when MAX_BODY_BYTES is not a valid integer", () => {
    process.env.MAX_BODY_BYTES = "notanumber";

    expect(() => loadConfig()).toThrow(
      "MAX_BODY_BYTES must be a valid integer"
    );
  });

  it("loads screening config when SCREENING_URL is set", () => {
    process.env.SCREENING_URL = "http://elliptic-proxy:3000";
    process.env.SCREENING_PARTNER_NAME = "test-partner";
    process.env.SCREENING_PARTNER_SECRET = "c2VjcmV0";
    process.env.SCREENING_POOL_ADDRESS = "0xpool";

    const config = loadConfig();
    expect(config.screening).toEqual({
      ellipticProxyUrl: "http://elliptic-proxy:3000",
      partnerName: "test-partner",
      partnerSecret: "c2VjcmV0",
      timeoutMs: 10000,
      failOpen: false,
      maxRetries: 2,
      totalTimeoutMs: 10000,
      poolAddress: "0xpool",
    });
  });

  it("screening is undefined when SCREENING_URL is not set", () => {
    delete process.env.SCREENING_URL;

    const config = loadConfig();
    expect(config.screening).toBeUndefined();
  });

  it("throws when SCREENING_URL is set but SCREENING_PARTNER_NAME is missing", () => {
    process.env.SCREENING_URL = "http://elliptic-proxy:3000";
    delete process.env.SCREENING_PARTNER_NAME;
    delete process.env.SCREENING_PARTNER_SECRET;

    expect(() => loadConfig()).toThrow("SCREENING_PARTNER_NAME");
  });

  it("throws when SCREENING_URL is set but SCREENING_POOL_ADDRESS is missing", () => {
    process.env.SCREENING_URL = "http://elliptic-proxy:3000";
    process.env.SCREENING_PARTNER_NAME = "test-partner";
    process.env.SCREENING_PARTNER_SECRET = "c2VjcmV0";
    delete process.env.SCREENING_POOL_ADDRESS;

    expect(() => loadConfig()).toThrow("SCREENING_POOL_ADDRESS");
  });

  it("logs error when ARCHIVAL_GCS_BUCKET is not set", () => {
    delete process.env.ARCHIVAL_GCS_BUCKET;

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = loadConfig();
    expect(config.archival).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("archival_disabled")
    );
    spy.mockRestore();
  });

  it("loads archival config when ARCHIVAL_GCS_BUCKET is set", () => {
    process.env.ARCHIVAL_GCS_BUCKET = "my-bucket";
    process.env.ARCHIVAL_GCS_KEY_FILE = "/path/to/key.json";

    const config = loadConfig();
    expect(config.archival).toEqual({
      gcsBucket: "my-bucket",
      gcsKeyFilePath: "/path/to/key.json",
    });
  });

  it("loads archival config without key file", () => {
    process.env.ARCHIVAL_GCS_BUCKET = "my-bucket";
    delete process.env.ARCHIVAL_GCS_KEY_FILE;

    const config = loadConfig();
    expect(config.archival?.gcsBucket).toBe("my-bucket");
    expect(config.archival?.gcsKeyFilePath).toBeUndefined();
  });
});
