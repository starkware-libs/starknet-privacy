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

  it("leaves operator-policy fields unset by default", async () => {
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(VALID_CONFIG));
    const loader = new ConfigLoader(fetcher);
    const config = await loader.get();
    expect(config.skipElliptic).toBeUndefined();
    expect(config.additionalBlockedAddresses).toBeUndefined();
    expect(config.blockOverrideAddresses).toBeUndefined();
  });

  it("accepts skipElliptic with operator-curated lists, lowercasing addresses", async () => {
    const config = {
      ...VALID_CONFIG,
      skipElliptic: true,
      additionalBlockedAddresses: ["0xABCDEF", "0xdeadbeef"],
      blockOverrideAddresses: ["0xCAFE"],
    };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(config));
    const loader = new ConfigLoader(fetcher);
    const loaded = await loader.get();
    expect(loaded.skipElliptic).toBe(true);
    expect(loaded.additionalBlockedAddresses).toEqual([
      "0xabcdef",
      "0xdeadbeef",
    ]);
    expect(loaded.blockOverrideAddresses).toEqual(["0xcafe"]);
  });

  it("throws when skipElliptic is not a boolean", async () => {
    const invalidConfig = { ...VALID_CONFIG, skipElliptic: "yes" };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "skipElliptic must be a boolean"
    );
  });

  it("throws when additionalBlockedAddresses is not a string array", async () => {
    const invalidConfig = {
      ...VALID_CONFIG,
      additionalBlockedAddresses: ["0xabc", 123],
    };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "additionalBlockedAddresses must be string[]"
    );
  });

  it("throws when blockOverrideAddresses is not a string array", async () => {
    const invalidConfig = {
      ...VALID_CONFIG,
      blockOverrideAddresses: "not-an-array",
    };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "blockOverrideAddresses must be string[]"
    );
  });
});
