// src/rate-limit.ts

import { LRUCache } from "lru-cache";

// Simple fixed-window rate limiter: counts requests per partner within a 1-minute window.
// Uses LRU eviction when the partner count reaches capacity.
interface Window {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000;
const MAX_PARTNERS = 20;

export class RateLimiter {
  private windows = new LRUCache<string, Window>({
    max: MAX_PARTNERS,
    ttl: WINDOW_MS,
  });

  check(partnerName: string, limitPerMinute: number): boolean {
    const now = Date.now();
    const window = this.windows.get(partnerName);

    if (!window || now - window.windowStart >= WINDOW_MS) {
      this.windows.set(partnerName, { count: 1, windowStart: now });
      return true;
    }

    if (window.count >= limitPerMinute) {
      return false;
    }

    window.count++;
    return true;
  }
}
