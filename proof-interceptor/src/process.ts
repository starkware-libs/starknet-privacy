// src/process.ts
import { processCrashesTotal } from "./metrics.js";

/**
 * Installs handlers for `uncaughtException` and `unhandledRejection`. Each
 * handler logs the failure (with stack trace when available), increments
 * `processCrashesTotal` labelled by `source`, and exits the process with code 1.
 *
 * Without these handlers, an uncaught throw or unhandled promise rejection
 * tears the process down with no log line — observability requirements call
 * for a breadcrumb before exit so operators can correlate the restart with the
 * cause.
 */
export function installProcessCrashHandlers(): void {
  process.on("uncaughtException", (error) => {
    processCrashesTotal.inc({ source: "uncaught_exception" });
    console.error(
      JSON.stringify({
        event: "uncaught_exception",
        message: error.message,
        stack: error.stack,
      })
    );
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    processCrashesTotal.inc({ source: "unhandled_rejection" });
    const error = reason instanceof Error ? reason : new Error(String(reason));
    console.error(
      JSON.stringify({
        event: "unhandled_rejection",
        message: error.message,
        stack: error.stack,
      })
    );
    process.exit(1);
  });
}
