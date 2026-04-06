// tests/config.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  it("loads config with defaults", () => {
    const config = loadConfig();
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
    expect(config.maxBodyBytes).toBe(5 * 1024 * 1024);
    expect(config.tls).toBeUndefined();
  });

  it("reads port and host from env", () => {
    process.env.HOST = "127.0.0.1";
    process.env.PORT = "9090";
    const config = loadConfig();
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(9090);
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

  it("reads maxBodyBytes from env", () => {
    process.env.MAX_BODY_BYTES = "1048576";
    const config = loadConfig();
    expect(config.maxBodyBytes).toBe(1048576);
  });
});
