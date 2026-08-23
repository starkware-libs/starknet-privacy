// tests/config.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  DEFAULT_POLICY_TIMEOUT_MS,
  DEFAULT_POLICY_TTL_MS,
} from "../src/screening-policy.js";

/** The env every screening test needs: `loadConfig` requires all of these once screening is on. */
function setScreeningEnv(): void {
  process.env.SCREENING_URL = "http://elliptic-proxy:3000";
  process.env.SCREENING_PARTNER_NAME = "test-partner";
  process.env.SCREENING_PARTNER_SECRET = "c2VjcmV0";
  process.env.SCREENING_POOL_ADDRESS = "0xpool";
  process.env.SCREENING_RPC_URL = "http://starknet-rpc:5050";
  process.env.SCREENING_ANONYMIZER_ADDRESS = "0xanonymizer";
}

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
    delete process.env.SCREENING_POLICY_TTL_MS;
    delete process.env.SCREENING_POLICY_TIMEOUT_MS;
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
    setScreeningEnv();

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
      rpcUrl: "http://starknet-rpc:5050",
      anonymizerAddress: "0xanonymizer",
      policyTtlMs: DEFAULT_POLICY_TTL_MS,
      policyTimeoutMs: DEFAULT_POLICY_TIMEOUT_MS,
      blockNonPoolTx: false,
    });
  });

  it.each(["SCREENING_RPC_URL", "SCREENING_ANONYMIZER_ADDRESS"])(
    "refuses to start with screening on and %s missing",
    (missing) => {
      // Failing at startup beats failing per transaction: without either value the interceptor
      // cannot resolve a policy or derive a shadow account, so every affected flow would block.
      setScreeningEnv();
      delete process.env[missing];

      expect(() => loadConfig()).toThrow(`${missing} env var is required`);
    }
  );

  it("takes the policy TTL and timeout from the env", () => {
    setScreeningEnv();
    process.env.SCREENING_POLICY_TTL_MS = "5000";
    process.env.SCREENING_POLICY_TIMEOUT_MS = "250";

    const config = loadConfig();
    expect(config.screening?.policyTtlMs).toBe(5000);
    expect(config.screening?.policyTimeoutMs).toBe(250);
  });

  it("enables blockNonPoolTx when SCREENING_BLOCK_NON_POOL_TX is 'true'", () => {
    setScreeningEnv();
    process.env.SCREENING_BLOCK_NON_POOL_TX = "true";

    const config = loadConfig();
    expect(config.screening?.blockNonPoolTx).toBe(true);
  });

  it("leaves blockNonPoolTx false for any value other than 'true'", () => {
    setScreeningEnv();
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
