// src/shutdown.ts
import type { Server } from "node:http";

export function setupGracefulShutdown(server: Server): void {
  const shutdown = () => {
    console.log("Shutting down...");
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
