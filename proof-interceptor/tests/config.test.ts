// tests/config.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig, redactConfig, type Config } from "../src/config.js";

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
  });

  it("loads config from env vars", () => {
    process.env.HOST = "0.0.0.0";
    process.env.PORT = "9090";

    const config = loadConfig();
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9090);
    expect(config.maxBodyBytes).toBe(5 * 1024 * 1024);
    expect(config.tls).toBeUndefined();
  });

  it("uses defaults for host and port", () => {
    delete process.env.HOST;
    delete process.env.PORT;

    const config = loadConfig();
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
  });

  it("loads TLS config when both cert and key are set", () => {
    process.env.TLS_CERT_PATH = "/path/to/cert.pem";
    process.env.TLS_KEY_PATH = "/path/to/key.pem";

    const config = loadConfig();
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

    const config = loadConfig();
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
      blockNonPoolTx: false,
      healthMaxUnavailableMs: 30000,
    });
  });

  it("enables blockNonPoolTx when SCREENING_BLOCK_NON_POOL_TX is 'true'", () => {
    process.env.SCREENING_URL = "http://elliptic-proxy:3000";
    process.env.SCREENING_PARTNER_NAME = "test-partner";
    process.env.SCREENING_PARTNER_SECRET = "c2VjcmV0";
    process.env.SCREENING_POOL_ADDRESS = "0xpool";
    process.env.SCREENING_BLOCK_NON_POOL_TX = "true";

    const config = loadConfig();
    expect(config.screening?.blockNonPoolTx).toBe(true);
  });

  it("leaves blockNonPoolTx false for any value other than 'true'", () => {
    process.env.SCREENING_URL = "http://elliptic-proxy:3000";
    process.env.SCREENING_PARTNER_NAME = "test-partner";
    process.env.SCREENING_PARTNER_SECRET = "c2VjcmV0";
    process.env.SCREENING_POOL_ADDRESS = "0xpool";
    process.env.SCREENING_BLOCK_NON_POOL_TX = "1";

    const config = loadConfig();
    expect(config.screening?.blockNonPoolTx).toBe(false);
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
});

describe("redactConfig", () => {
  const baseConfig: Config = {
    host: "0.0.0.0",
    port: 8080,
    maxBodyBytes: 5 * 1024 * 1024,
  };

  it("returns plain config untouched when no screening or TLS is set", () => {
    expect(redactConfig(baseConfig)).toEqual(baseConfig);
  });

  it("masks partnerSecret but preserves other screening fields", () => {
    const config: Config = {
      ...baseConfig,
      screening: {
        ellipticProxyUrl: "http://elliptic-proxy:3000",
        partnerName: "test-partner",
        partnerSecret: "supersecret",
        timeoutMs: 1000,
        failOpen: false,
        maxRetries: 0,
        totalTimeoutMs: 5000,
        poolAddress: "0xabc",
        blockNonPoolTx: true,
      },
    };
    const redacted = redactConfig(config);
    const screening = (redacted.screening ?? {}) as Record<string, unknown>;
    expect(screening.partnerSecret).toBe("[REDACTED]");
    expect(screening.partnerName).toBe("test-partner");
    expect(screening.ellipticProxyUrl).toBe("http://elliptic-proxy:3000");
    expect(JSON.stringify(redacted)).not.toContain("supersecret");
  });

  it("marks an empty partnerSecret as [EMPTY] so misconfiguration stays visible", () => {
    const config: Config = {
      ...baseConfig,
      screening: {
        ellipticProxyUrl: "http://elliptic-proxy:3000",
        partnerName: "test-partner",
        partnerSecret: "",
        timeoutMs: 1000,
        failOpen: false,
        maxRetries: 0,
        totalTimeoutMs: 5000,
        poolAddress: "0xabc",
        blockNonPoolTx: false,
      },
    };
    const redacted = redactConfig(config);
    expect((redacted.screening as Record<string, unknown>).partnerSecret).toBe(
      "[EMPTY]"
    );
  });

  it("collapses TLS to {enabled: true} so cert/key paths don't appear", () => {
    const config: Config = {
      ...baseConfig,
      tls: { certPath: "/etc/cert.pem", keyPath: "/etc/key.pem" },
    };
    const redacted = redactConfig(config);
    expect(redacted.tls).toEqual({ enabled: true });
    expect(JSON.stringify(redacted)).not.toContain("/etc/cert.pem");
    expect(JSON.stringify(redacted)).not.toContain("/etc/key.pem");
  });
});
