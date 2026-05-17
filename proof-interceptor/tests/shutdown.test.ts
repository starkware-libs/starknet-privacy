// tests/shutdown.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { setupGracefulShutdown } from "../src/shutdown.js";

let server: Server;
let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  if (server && server.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function startServerOnEphemeralPort(): Promise<Server> {
  server = createServer();
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server))
  );
}

function findJsonLog(
  spy: ReturnType<typeof vi.spyOn>,
  event: string
): Record<string, unknown> | undefined {
  for (const call of spy.mock.calls) {
    const arg = call[0];
    if (typeof arg !== "string") continue;
    try {
      const parsed = JSON.parse(arg) as Record<string, unknown>;
      if (parsed.event === event) return parsed;
    } catch {
      // skip non-JSON lines
    }
  }
  return undefined;
}

describe("setupGracefulShutdown", () => {
  it("logs shutdown_started and shutdown_complete on SIGTERM", async () => {
    await startServerOnEphemeralPort();
    setupGracefulShutdown(server);

    process.emit("SIGTERM");

    // Wait until exit was called (server.close finished)
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalled();
    });

    const started = findJsonLog(logSpy, "shutdown_started");
    const complete = findJsonLog(logSpy, "shutdown_complete");
    expect(started).toEqual({ event: "shutdown_started", signal: "SIGTERM" });
    expect(complete).toEqual({ event: "shutdown_complete" });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("ignores a second signal while shutdown is in flight", async () => {
    await startServerOnEphemeralPort();
    setupGracefulShutdown(server);

    process.emit("SIGTERM");
    process.emit("SIGINT");

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalled();
    });

    const ignored = findJsonLog(logSpy, "shutdown_signal_ignored");
    expect(ignored).toEqual({
      event: "shutdown_signal_ignored",
      signal: "SIGINT",
      reason: "shutdown already in progress",
    });
  });
});
