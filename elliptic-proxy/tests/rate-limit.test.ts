// tests/rate-limit.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter } from "../src/rate-limit.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
});
