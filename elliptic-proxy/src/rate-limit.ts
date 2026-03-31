// src/rate-limit.ts

// Simple fixed-window rate limiter: counts requests per partner within a 1-minute window.
interface Window {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000;
const MAX_PARTNERS = 20;

export class RateLimiter {
  private windows = new Map<string, Window>();

  check(partnerName: string, limitPerMinute: number): boolean {
    const now = Date.now();
    const window = this.windows.get(partnerName);

    if (!window || now - window.windowStart >= WINDOW_MS) {
      if (!window && this.windows.size >= MAX_PARTNERS) {
        return false;
      }
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
