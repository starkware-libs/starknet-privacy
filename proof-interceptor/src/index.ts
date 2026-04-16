// src/index.ts
import { loadConfig } from "./config.js";
import { createHandler } from "./proxy.js";
import { startServer } from "./server.js";
import { setupGracefulShutdown } from "./shutdown.js";

const config = loadConfig();
const handler = createHandler({
  maxBodyBytes: config.maxBodyBytes,
});
const server = await startServer(config, handler);
setupGracefulShutdown(server);
