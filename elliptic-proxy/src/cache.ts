// src/cache.ts

import { LRUCache } from "lru-cache";

const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * In-memory cache for blocked addresses. Only caches blocked results —
 * non-blocked addresses are always re-screened. Uses LRU eviction when
 * the cache reaches capacity.
 */
export class BlockedAddressCache {
  private readonly cache: LRUCache<string, true>;

  constructor(
    ttlMs: number,
    maxEntries: number = DEFAULT_MAX_ENTRIES,
    clock: { now(): number } = performance
  ) {
    this.cache = new LRUCache<string, true>({
      max: maxEntries,
      ttl: ttlMs,
      perf: clock,
    });
  }

  isBlocked(address: string): boolean {
    return this.cache.has(address);
  }

  markBlocked(address: string): void {
    this.cache.set(address, true);
  }

  get size(): number {
    return this.cache.size;
  }
}
