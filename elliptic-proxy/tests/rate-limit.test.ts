// tests/rate-limit.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "../src/rate-limit.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within limit", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("partner-a", 5)).toBe(true);
    }
  });

  it("rejects requests exceeding limit", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.check("partner-a", 5);
    }
    expect(limiter.check("partner-a", 5)).toBe(false);
  });

  it("resets after one minute", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.check("partner-a", 5);
    }
    expect(limiter.check("partner-a", 5)).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(limiter.check("partner-a", 5)).toBe(true);
  });

  it("tracks partners independently", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.check("partner-a", 5);
    }
    expect(limiter.check("partner-a", 5)).toBe(false);
    expect(limiter.check("partner-b", 5)).toBe(true);
  });

  it("evicts expired windows when MAX_PARTNERS is reached", () => {
    const limiter = new RateLimiter();
    for (let partnerIndex = 0; partnerIndex < 20; partnerIndex++) {
      expect(limiter.check(`partner-${partnerIndex}`, 100)).toBe(true);
    }

    vi.advanceTimersByTime(60_000);

    expect(limiter.check("partner-new", 100)).toBe(true);
  });

  it("evicts LRU partner when MAX_PARTNERS reached and none expired", () => {
    const limiter = new RateLimiter();
    for (let partnerIndex = 0; partnerIndex < 20; partnerIndex++) {
      limiter.check(`partner-${partnerIndex}`, 100);
      vi.advanceTimersByTime(1);
    }

    expect(limiter.check("partner-new", 100)).toBe(true);

    // partner-0 was evicted (LRU), fresh check creates a new window
    expect(limiter.check("partner-0", 100)).toBe(true);
  });
});
