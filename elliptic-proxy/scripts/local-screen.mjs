#!/usr/bin/env node
// Run the proxy pipeline locally against a config file and a single address.
// Loads the config through the proxy's own ConfigLoader (same validation the
// deployed function uses), then calls forwardToElliptic + scoreResponse and
// prints the verdict the proxy would return.
//
// Usage:
//   node scripts/local-screen.mjs <config.json> <address>
//
// Build first: `npm run build` (imports from dist/).

import { readFile } from "node:fs/promises";
import { ConfigLoader } from "../dist/config.js";
import { forwardToElliptic } from "../dist/elliptic.js";
import { scoreResponse } from "../dist/scoring.js";

const [, , configPath, addressArg] = process.argv;
if (!configPath || !addressArg) {
  console.error("usage: local-screen.mjs <config.json> <address>");
  process.exit(2);
}

const loader = new ConfigLoader(() => readFile(configPath, "utf8"));
const config = await loader.get();

const address = addressArg.toLowerCase();
const upstream = await forwardToElliptic({
  ellipticUrl: config.elliptic.url,
  ellipticKey: config.elliptic.key,
  ellipticSecret: config.elliptic.secret,
  ellipticTimeoutMs: config.elliptic.timeoutMs,
  address,
});

console.error(`elliptic HTTP ${upstream.status}  (${upstream.durationMs} ms)`);

if (upstream.status < 200 || upstream.status >= 300) {
  console.error("upstream error — body:");
  console.error(upstream.body);
  process.exit(1);
}

const verdict = scoreResponse(upstream.body);
// Match the proxy's on-the-wire response shape (handler.ts sends { blocked }).
// Full verdict details are printed to stderr for inspection.
console.error("verdict detail:", JSON.stringify(verdict));
console.log(JSON.stringify({ blocked: verdict.blocked }));
process.exit(0);
