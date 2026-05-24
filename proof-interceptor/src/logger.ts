// src/logger.ts
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context propagated via Node's `AsyncLocalStorage`. Anything
 * logged inside a `withRequestId(...)` scope automatically picks up the
 * request id, so downstream error logs (interceptors, screening, etc.) link
 * back to the originating HTTP request without explicit threading.
 */
interface LogContext {
  requestId: string;
}

const context = new AsyncLocalStorage<LogContext>();

export function withRequestId<T>(
  requestId: string,
  fn: () => T | Promise<T>
): T | Promise<T> {
  return context.run({ requestId }, fn);
}

export function currentRequestId(): string | undefined {
  return context.getStore()?.requestId;
}

type LogLevel = "info" | "warn" | "error";

function emit(level: LogLevel, fields: Record<string, unknown>): void {
  const requestId = context.getStore()?.requestId;
  const payload: Record<string, unknown> = {
    level,
    ...(requestId !== undefined ? { request_id: requestId } : {}),
    ...fields,
  };
  const sink = level === "error" ? console.error : console.log;
  sink(JSON.stringify(payload));
}

export const logger = {
  info(fields: Record<string, unknown>): void {
    emit("info", fields);
  },
  warn(fields: Record<string, unknown>): void {
    emit("warn", fields);
  },
  error(fields: Record<string, unknown>): void {
    emit("error", fields);
  },
};
