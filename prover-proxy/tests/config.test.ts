// tests/config.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  it("loads config from env vars", () => {
    process.env.UPSTREAM_URL = "http://localhost:3000";
    process.env.HOST = "0.0.0.0";
    process.env.PORT = "9090";

    const config = loadConfig();
    expect(config.upstreamUrl).toBe("http://localhost:3000");
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9090);
    expect(config.maxBodyBytes).toBe(5 * 1024 * 1024);
    expect(config.tls).toBeUndefined();
  });

  it("uses defaults for host and port", () => {
    process.env.UPSTREAM_URL = "http://localhost:3000";
    delete process.env.HOST;
    delete process.env.PORT;

    const config = loadConfig();
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
  });

  it("loads TLS config when both cert and key are set", () => {
    process.env.UPSTREAM_URL = "http://localhost:3000";
    process.env.TLS_CERT_PATH = "/path/to/cert.pem";
    process.env.TLS_KEY_PATH = "/path/to/key.pem";

    const config = loadConfig();
    expect(config.tls).toEqual({
      certPath: "/path/to/cert.pem",
      keyPath: "/path/to/key.pem",
    });
  });

  it("throws when only TLS_CERT_PATH is set", () => {
    process.env.UPSTREAM_URL = "http://localhost:3000";
    process.env.TLS_CERT_PATH = "/path/to/cert.pem";
    delete process.env.TLS_KEY_PATH;

    expect(() => loadConfig()).toThrow("both be set or both absent");
  });

  it("throws when UPSTREAM_URL is missing", () => {
    delete process.env.UPSTREAM_URL;
    expect(() => loadConfig()).toThrow("UPSTREAM_URL");
  });

  it("reads maxBodyBytes from MAX_BODY_BYTES env var", () => {
    process.env.UPSTREAM_URL = "http://localhost:3000";
    process.env.MAX_BODY_BYTES = "1048576";

    const config = loadConfig();
    expect(config.maxBodyBytes).toBe(1048576);
  });
});
