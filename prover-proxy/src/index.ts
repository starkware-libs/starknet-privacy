// src/index.ts
import { loadConfig } from "./config.js";
import { createProxyHandler } from "./proxy.js";
import { startServer } from "./server.js";
import { setupGracefulShutdown } from "./shutdown.js";
import { ScreeningInterceptor } from "./screening-interceptor.js";
import type { TransactionInterceptor } from "./interceptor.js";

const config = loadConfig();

const interceptors: TransactionInterceptor[] = [];
if (config.screening) {
  interceptors.push(new ScreeningInterceptor(config.screening));
}

const handler = createProxyHandler(config.upstreamUrl, {
  forwardUnknownMethods: config.forwardUnknownMethods,
  maxBodyBytes: config.maxBodyBytes,
  interceptors,
});
const server = await startServer(config, handler);
setupGracefulShutdown(server);
