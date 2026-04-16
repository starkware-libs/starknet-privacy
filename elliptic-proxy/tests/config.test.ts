// tests/config.test.ts
import { describe, it, expect, vi } from "vitest";
import { ConfigLoader } from "../src/config.js";

const VALID_CONFIG = {
  elliptic: {
    url: "https://api.elliptic.co",
    key: "elliptic-key",
    secret: btoa("elliptic-secret"),
    timeoutMs: 10000,
  },
  rateLimitPerMinute: 100,
  maxBodyBytes: 10240,
  configCacheTtlSeconds: 2,
  blockedCacheTtlSeconds: 300,
  partners: {
    "prover-proxy": btoa("secret-aaa"),
    "other-service": btoa("secret-bbb"),
  },
};

describe("ConfigLoader", () => {
  it("loads and parses config from fetcher", async () => {
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(VALID_CONFIG));
    const loader = new ConfigLoader(fetcher);
    const config = await loader.get();
    expect(config.elliptic.key).toBe("elliptic-key");
    expect(config.partners["prover-proxy"]).toBe(btoa("secret-aaa"));
  });

  it("returns cached config within TTL", async () => {
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(VALID_CONFIG));
    const loader = new ConfigLoader(fetcher);
    await loader.get();
    await loader.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(VALID_CONFIG));
    const loader = new ConfigLoader(fetcher);
    await loader.get();

    vi.advanceTimersByTime(3000);

    // TTL is 2s, so next get() after 3s should re-fetch
    await loader.get();
    expect(fetcher).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("throws on invalid config JSON", async () => {
    const fetcher = vi.fn().mockResolvedValue("not json");
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow();
  });

  it("throws when rateLimitPerMinute is zero", async () => {
    const invalidConfig = { ...VALID_CONFIG, rateLimitPerMinute: 0 };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "rateLimitPerMinute must be a positive number"
    );
  });

  it("throws when timeoutMs is zero", async () => {
    const invalidConfig = {
      ...VALID_CONFIG,
      elliptic: { ...VALID_CONFIG.elliptic, timeoutMs: 0 },
    };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "timeoutMs must be a positive number"
    );
  });

  it("throws when maxBodyBytes is negative", async () => {
    const invalidConfig = { ...VALID_CONFIG, maxBodyBytes: -1 };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "maxBodyBytes must be a positive number"
    );
  });

  it("throws when configCacheTtlSeconds is zero", async () => {
    const invalidConfig = { ...VALID_CONFIG, configCacheTtlSeconds: 0 };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "configCacheTtlSeconds must be a positive number"
    );
  });

  it("throws when a partner secret is not a string", async () => {
    const invalidConfig = {
      ...VALID_CONFIG,
      partners: { "bad-partner": 123 },
    };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "partners.bad-partner must be a non-empty string"
    );
  });
});
