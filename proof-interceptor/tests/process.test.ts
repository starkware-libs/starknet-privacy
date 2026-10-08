// tests/process.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installProcessCrashHandlers } from "../src/process.js";
import { processCrashesTotal } from "../src/metrics.js";

let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

async function crashCounterValue(source: string): Promise<number> {
  const data = await processCrashesTotal.get();
  const sample = data.values.find((entry) => entry.labels.source === source);
  return sample?.value ?? 0;
}

beforeEach(() => {
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
});

afterEach(() => {
  exitSpy.mockRestore();
  errorSpy.mockRestore();
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
});

describe("installProcessCrashHandlers", () => {
  it("logs and exits on uncaughtException, incrementing the counter", async () => {
    const before = await crashCounterValue("uncaught_exception");
    installProcessCrashHandlers();

    process.emit("uncaughtException", new Error("boom"));

    expect(exitSpy).toHaveBeenCalledWith(1);
    const after = await crashCounterValue("uncaught_exception");
    expect(after).toBe(before + 1);

    const logged = errorSpy.mock.calls.find((call) =>
      String(call[0]).includes("uncaught_exception")
    );
    expect(logged).toBeDefined();
    const parsed = JSON.parse(String(logged![0])) as Record<string, unknown>;
    expect(parsed.event).toBe("uncaught_exception");
    expect(parsed.message).toBe("boom");
    expect(typeof parsed.stack).toBe("string");
  });

  it("logs and exits on unhandledRejection with Error reason", async () => {
    const before = await crashCounterValue("unhandled_rejection");
    installProcessCrashHandlers();

    process.emit("unhandledRejection", new Error("nope"), Promise.resolve());

    expect(exitSpy).toHaveBeenCalledWith(1);
    const after = await crashCounterValue("unhandled_rejection");
    expect(after).toBe(before + 1);
  });

  it("normalizes non-Error rejection reasons into an Error", async () => {
    installProcessCrashHandlers();

    process.emit("unhandledRejection", "string reason", Promise.resolve());

    const logged = errorSpy.mock.calls.find((call) =>
      String(call[0]).includes("unhandled_rejection")
    );
    expect(logged).toBeDefined();
    const parsed = JSON.parse(String(logged![0])) as Record<string, unknown>;
    expect(parsed.message).toBe("string reason");
  });
});
