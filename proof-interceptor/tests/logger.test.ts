// tests/logger.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger, withRequestId } from "../src/logger.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

function lastJson(
  spy: ReturnType<typeof vi.spyOn>
): Record<string, unknown> | undefined {
  const call = spy.mock.calls[spy.mock.calls.length - 1];
  if (!call) return undefined;
  return JSON.parse(call[0] as string) as Record<string, unknown>;
}

describe("logger", () => {
  it("omits request_id when called outside a request scope", () => {
    logger.info({ event: "startup" });
    const entry = lastJson(logSpy);
    expect(entry).toEqual({ level: "info", event: "startup" });
  });

  it("auto-injects request_id when called inside withRequestId", async () => {
    await withRequestId("abc-123", async () => {
      logger.info({ event: "served" });
    });
    expect(lastJson(logSpy)).toEqual({
      level: "info",
      request_id: "abc-123",
      event: "served",
    });
  });

  it("propagates request_id across awaits and nested async calls", async () => {
    await withRequestId("deep-1", async () => {
      await Promise.resolve();
      await (async () => {
        await new Promise((resolve) => setImmediate(resolve));
        logger.warn({ event: "inner" });
      })();
    });
    expect(lastJson(logSpy)).toEqual({
      level: "warn",
      request_id: "deep-1",
      event: "inner",
    });
  });

  it("routes error level to console.error", () => {
    logger.error({ event: "boom" });
    expect(errorSpy).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("isolates request_id between concurrent scopes", async () => {
    const captured: Array<Record<string, unknown> | undefined> = [];
    const work = (id: string) =>
      withRequestId(id, async () => {
        // Force interleaving
        await new Promise((resolve) => setImmediate(resolve));
        logger.info({ event: "tick", id });
        captured.push(lastJson(logSpy));
      });
    await Promise.all([work("A"), work("B")]);
    const requestIds = captured.map((entry) => entry?.request_id);
    expect(requestIds.sort()).toEqual(["A", "B"]);
  });
});
