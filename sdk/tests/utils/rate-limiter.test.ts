import { describe, it, expect } from "vitest";
import { createLimiter, createRateLimitedObject } from "../../src/utils/rate-limiter.js";

describe("createLimiter", () => {
  it("respects concurrency limit", async () => {
    const limit = createLimiter(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async (delay: number) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, delay));
      concurrent--;
      return delay;
    };

    const delay = 5;
    // Launch 5 tasks, but only 2 should run at a time
    const results = await Promise.all([
      limit(() => task(delay)),
      limit(() => task(delay)),
      limit(() => task(delay)),
      limit(() => task(delay)),
      limit(() => task(delay)),
    ]);

    expect(maxConcurrent).toBe(2);
    expect(results).toEqual([delay, delay, delay, delay, delay]);
  });

  it("maintains FIFO order for queued tasks", async () => {
    const limit = createLimiter(1);
    const order: number[] = [];

    const task = async (id: number) => {
      order.push(id);
      await new Promise((r) => setTimeout(r, 10));
      return id;
    };

    await Promise.all([limit(() => task(1)), limit(() => task(2)), limit(() => task(3))]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("handles errors without blocking the queue", async () => {
    const limit = createLimiter(1);
    const results: (number | string)[] = [];

    const successTask = async (id: number) => {
      results.push(id);
      return id;
    };

    const failTask = async () => {
      throw new Error("fail");
    };

    const p1 = limit(() => successTask(1));
    const p2 = limit(failTask).catch(() => "caught");
    const p3 = limit(() => successTask(3));

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toBe(1);
    expect(r2).toBe("caught");
    expect(r3).toBe(3);
    expect(results).toEqual([1, 3]);
  });
});

describe("createRateLimitedPool", () => {
  it("applies concurrency across multiple methods", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const obj = {
      async methodA() {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
        return "A";
      },
      async methodB() {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
        return "B";
      },
    };

    const limited = createRateLimitedObject(obj, { concurrency: 2, maxRetries: 0 });

    const results = await Promise.all([
      limited.methodA(),
      limited.methodB(),
      limited.methodA(),
      limited.methodB(),
    ]);

    expect(maxConcurrent).toBe(2);
    expect(results).toContain("A");
    expect(results).toContain("B");
  });

  it("retries failed operations with exponential backoff", async () => {
    let attempts = 0;

    const obj = {
      async flaky() {
        attempts++;
        if (attempts < 3) {
          throw new Error(`Attempt ${attempts} failed`);
        }
        return "success";
      },
    };

    const limited = createRateLimitedObject(obj, {
      concurrency: 1,
      maxRetries: 3,
      baseDelayMs: 10,
    });

    const result = await limited.flaky();

    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("throws after max retries exceeded", async () => {
    const obj = {
      async alwaysFails() {
        throw new Error("Always fails");
      },
    };

    const limited = createRateLimitedObject(obj, {
      concurrency: 1,
      maxRetries: 2,
      baseDelayMs: 1,
    });

    await expect(limited.alwaysFails()).rejects.toThrow("Always fails");
  });

  it("handles synchronous methods", async () => {
    const pool = {
      sync() {
        return 42;
      },
    };

    const limited = createRateLimitedObject(pool, { concurrency: 1 });

    // Synchronous methods still get wrapped and return promises
    const result = await limited.sync();
    expect(result).toBe(42);
  });
});
