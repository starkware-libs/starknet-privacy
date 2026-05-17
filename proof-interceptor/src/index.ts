// src/index.ts
import { loadConfig, redactConfig } from "./config.js";
import { createHandler } from "./proxy.js";
import { startServer } from "./server.js";
import { setupGracefulShutdown } from "./shutdown.js";
import { ScreeningInterceptor } from "./screening-interceptor.js";
import { GIT_SHA, SERVICE_VERSION } from "./build_info.js";
// Importing `metrics` for its side effect: registering the build_info gauge so
// it appears in /metrics output before the first scrape.
import "./metrics.js";
import type { TransactionInterceptor } from "./interceptor.js";

const config = loadConfig();

// Startup banner — version + git SHA + redacted config (no secrets) so a
// running pod can be tied back to a deploy from logs alone. See `build_info.ts`
// for how GIT_SHA is supplied to the binary.
console.log(
  JSON.stringify({
    level: "info",
    event: "startup",
    version: SERVICE_VERSION,
    git_sha: GIT_SHA,
    config: redactConfig(config),
  })
);

const interceptors: TransactionInterceptor[] = [];
if (config.screening) {
  interceptors.push(new ScreeningInterceptor(config.screening));
}

const handler = createHandler({
  maxBodyBytes: config.maxBodyBytes,
  interceptors,
});
const server = await startServer(config, handler);
setupGracefulShutdown(server);
