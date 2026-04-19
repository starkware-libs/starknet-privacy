// tests/cache.test.ts
import { describe, it, expect } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { BlockedAddressCache } from "../src/cache.js";

describe("BlockedAddressCache", () => {
  it("returns false for unknown address", () => {
    const cache = new BlockedAddressCache(60_000);
    expect(cache.isBlocked("0xabc")).toBe(false);
  });

  it("returns true for cached blocked address", () => {
    const cache = new BlockedAddressCache(60_000);
    cache.markBlocked("0xabc");
    expect(cache.isBlocked("0xabc")).toBe(true);
  });

  it("expires after TTL", async () => {
    // Uses real time because lru-cache reads `perf.now()` internally and
    // debounces it via `setTimeout` on `ttlResolution`, which vitest fake
    // timers can't drive in unison.
    const cache = new BlockedAddressCache(20);
    cache.markBlocked("0xabc");

    expect(cache.isBlocked("0xabc")).toBe(true);

    await sleep(40);
    expect(cache.isBlocked("0xabc")).toBe(false);
  });

  it("does not cross-contaminate addresses", () => {
    const cache = new BlockedAddressCache(60_000);
    cache.markBlocked("0xabc");
    expect(cache.isBlocked("0xdef")).toBe(false);
  });

  it("evicts least-recently-used entry when max capacity is reached", () => {
    const cache = new BlockedAddressCache(60_000, 3);
    cache.markBlocked("0x1");
    cache.markBlocked("0x2");
    cache.markBlocked("0x3");
    expect(cache.size).toBe(3);

    // Adding a 4th entry evicts the oldest (0x1)
    cache.markBlocked("0x4");
    expect(cache.size).toBe(3);
    expect(cache.isBlocked("0x1")).toBe(false);
    expect(cache.isBlocked("0x4")).toBe(true);
  });
});
