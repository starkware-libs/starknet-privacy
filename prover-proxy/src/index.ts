// src/index.ts
import { loadConfig } from "./config.js";
import { createProxyHandler } from "./proxy.js";
import { startServer } from "./server.js";
import { setupGracefulShutdown } from "./shutdown.js";

const config = loadConfig();
const handler = createProxyHandler(config.upstreamUrl, config.maxBodyBytes);
const server = await startServer(config, handler);
setupGracefulShutdown(server);
