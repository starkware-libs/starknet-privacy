// src/shutdown.ts
import type { Server } from "node:http";

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;
type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/**
 * Wires SIGTERM/SIGINT to a graceful close of `server`. Emits structured logs
 * on signal receipt and after `server.close` finishes so deployments and
 * restarts are visible in logs (rather than disappearing into silence).
 * Repeated signals while shutdown is already in flight are ignored.
 */
export function setupGracefulShutdown(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: ShutdownSignal) => {
    if (shuttingDown) {
      console.log(
        JSON.stringify({
          event: "shutdown_signal_ignored",
          signal,
          reason: "shutdown already in progress",
        })
      );
      return;
    }
    shuttingDown = true;

    console.log(JSON.stringify({ event: "shutdown_started", signal }));
    server.close((error) => {
      if (error) {
        console.error(
          JSON.stringify({
            event: "shutdown_error",
            message: error.message,
          })
        );
        process.exit(1);
      }
      console.log(JSON.stringify({ event: "shutdown_complete" }));
      process.exit(0);
    });
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => shutdown(signal));
  }
}
