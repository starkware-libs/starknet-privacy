// tests/config.test.ts
import { describe, it, expect, vi } from "vitest";
import { ConfigLoader } from "../src/config.js";
import { LIVE_CHAIN_ID, SN_MAIN_CHAIN_ID } from "./helpers.js";

const VALID_CONFIG = {
  elliptic: {
    url: "https://api.elliptic.co",
    timeoutMs: 10000,
  },
  rateLimitPerMinute: 100,
  maxBodyBytes: 10240,
  configCacheTtlSeconds: 2,
  blockedCacheTtlSeconds: 300,
  partners: {
    "prover-proxy": {
      hmacSecret: btoa("secret-aaa"),
      ellipticKey: "prover-proxy-key",
      ellipticSecret: btoa("prover-proxy-elliptic"),
    },
    "other-service": {
      hmacSecret: btoa("secret-bbb"),
      ellipticKey: "other-service-key",
      ellipticSecret: btoa("other-service-elliptic"),
    },
  },
  signingPrivateKey: "0x1234",
  chainId: LIVE_CHAIN_ID,
};

// VALID_CONFIG with the mock Elliptic upstream selected.
const MOCK_UPSTREAM_CONFIG = {
  ...VALID_CONFIG,
  elliptic: { ...VALID_CONFIG.elliptic, url: "mock:" },
};

describe("ConfigLoader", () => {
  it("loads and parses config from fetcher", async () => {
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(VALID_CONFIG));
    const loader = new ConfigLoader(fetcher);
    const config = await loader.get();
    expect(config.elliptic.url).toBe("https://api.elliptic.co");
    expect(config.partners["prover-proxy"].hmacSecret).toBe(btoa("secret-aaa"));
    expect(config.partners["prover-proxy"].ellipticKey).toBe(
      "prover-proxy-key"
    );
    expect(config.partners["prover-proxy"].ellipticSecret).toBe(
      btoa("prover-proxy-elliptic")
    );
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

  it("throws when a partner entry is not an object", async () => {
    const invalidConfig = {
      ...VALID_CONFIG,
      partners: { "bad-partner": "just-a-secret" },
    };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "partners.bad-partner must be a non-null object"
    );
  });

  it("throws when a partner is missing its Elliptic key", async () => {
    const invalidConfig = {
      ...VALID_CONFIG,
      partners: {
        "bad-partner": {
          hmacSecret: btoa("secret"),
          ellipticSecret: btoa("elliptic"),
        },
      },
    };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "partners.bad-partner.ellipticKey must be a non-empty string"
    );
  });

  it("leaves the deny list unset by default", async () => {
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(VALID_CONFIG));
    const loader = new ConfigLoader(fetcher);
    const config = await loader.get();
    expect(config.additionalBlockedAddresses).toBeUndefined();
  });

  it("accepts a deny list, lowercasing addresses", async () => {
    const config = {
      ...VALID_CONFIG,
      additionalBlockedAddresses: ["0xABCDEF", "0xdeadbeef"],
    };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(config));
    const loader = new ConfigLoader(fetcher);
    const loaded = await loader.get();
    expect(loaded.additionalBlockedAddresses).toEqual([
      "0xabcdef",
      "0xdeadbeef",
    ]);
  });

  it("accepts an allow list, lowercasing addresses", async () => {
    const config = {
      ...VALID_CONFIG,
      blockOverrideAddresses: ["0xCAFE", "0xf00d"],
    };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(config));
    const loader = new ConfigLoader(fetcher);
    const loaded = await loader.get();
    expect(loaded.blockOverrideAddresses).toEqual(["0xcafe", "0xf00d"]);
  });

  it("throws when signingPrivateKey is missing", async () => {
    const withoutKey: Record<string, unknown> = { ...VALID_CONFIG };
    delete withoutKey.signingPrivateKey;
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(withoutKey));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "signingPrivateKey must be a non-empty string"
    );
  });

  it("throws when chainId is missing", async () => {
    const withoutChainId: Record<string, unknown> = { ...VALID_CONFIG };
    delete withoutChainId.chainId;
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(withoutChainId));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "chainId must be a non-empty string"
    );
  });

  it("throws when chainId is not a hex felt", async () => {
    const invalidConfig = { ...VALID_CONFIG, chainId: "LIVE_TEST" };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "chainId must be a 0x-prefixed hex felt"
    );
  });

  it("lowercases chainId", async () => {
    const config = { ...VALID_CONFIG, chainId: "0x4C4956455F54455354" };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(config));
    const loader = new ConfigLoader(fetcher);
    const loaded = await loader.get();
    expect(loaded.chainId).toBe(LIVE_CHAIN_ID);
  });

  it("rejects a mock elliptic.url with the SN_MAIN chainId", async () => {
    const invalidConfig = {
      ...MOCK_UPSTREAM_CONFIG,
      chainId: SN_MAIN_CHAIN_ID,
    };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "a mock elliptic.url is not allowed with the SN_MAIN chainId"
    );
  });

  it("accepts the SN_MAIN chainId with a live elliptic.url", async () => {
    const config = { ...VALID_CONFIG, chainId: SN_MAIN_CHAIN_ID };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(config));
    const loader = new ConfigLoader(fetcher);
    const loaded = await loader.get();
    expect(loaded.chainId).toBe(SN_MAIN_CHAIN_ID);
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

  it("throws when a list entry is not a hex felt", async () => {
    const invalidConfig = {
      ...VALID_CONFIG,
      additionalBlockedAddresses: ["not-hex"],
    };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "additionalBlockedAddresses entries must be 0x-prefixed hex felts"
    );
  });

  it("throws when an allow list entry is not a hex felt", async () => {
    const invalidConfig = {
      ...VALID_CONFIG,
      blockOverrideAddresses: ["0x" + "f".repeat(64)], // 64 digits can't fit a felt
    };
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "blockOverrideAddresses entries must be 0x-prefixed hex felts"
    );
  });

  it("throws when chainId exceeds the felt size", async () => {
    const invalidConfig = { ...VALID_CONFIG, chainId: "0x" + "f".repeat(63) }; // >= the Stark prime
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(invalidConfig));
    const loader = new ConfigLoader(fetcher);
    await expect(loader.get()).rejects.toThrow(
      "chainId must be a 0x-prefixed hex felt"
    );
  });

  it("parses an optional metricsAuthToken", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ ...VALID_CONFIG, metricsAuthToken: "scrape-token" })
      );
    const config = await new ConfigLoader(fetcher).get();
    expect(config.metricsAuthToken).toBe("scrape-token");
  });

  it("leaves metricsAuthToken undefined when omitted", async () => {
    const fetcher = vi.fn().mockResolvedValue(JSON.stringify(VALID_CONFIG));
    const config = await new ConfigLoader(fetcher).get();
    expect(config.metricsAuthToken).toBeUndefined();
  });

  it("rejects a non-string metricsAuthToken", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ ...VALID_CONFIG, metricsAuthToken: 123 })
      );
    await expect(new ConfigLoader(fetcher).get()).rejects.toThrow(
      "metricsAuthToken"
    );
  });

  describe("load-time warnings", () => {
    async function loadAndCaptureWarnings(
      config: Record<string, unknown>
    ): Promise<string[]> {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetcher = vi.fn().mockResolvedValue(JSON.stringify(config));
      await new ConfigLoader(fetcher).get();
      const warnings = warnSpy.mock.calls.map(
        (call) => JSON.parse(call[0] as string).warning as string
      );
      warnSpy.mockRestore();
      return warnings;
    }

    it("warns mock_mode for a mock elliptic.url", async () => {
      expect(await loadAndCaptureWarnings(MOCK_UPSTREAM_CONFIG)).toEqual([
        "mock_mode",
      ]);
    });

    it("does not warn for a live elliptic.url, with or without operator lists", async () => {
      expect(await loadAndCaptureWarnings(VALID_CONFIG)).toEqual([]);
      expect(
        await loadAndCaptureWarnings({
          ...VALID_CONFIG,
          additionalBlockedAddresses: ["0xdeadbeef"],
          blockOverrideAddresses: ["0xcafe"],
        })
      ).toEqual([]);
    });
  });
});
