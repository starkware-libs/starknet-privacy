#!/usr/bin/env node
// Run the proxy pipeline locally against a config file and a single address.
// Loads the config through the proxy's own ConfigLoader (same validation the
// deployed function uses), then calls forwardToElliptic + scoreResponse and
// prints the verdict the proxy would return.
//
// Usage:
//   node scripts/local-screen.mjs <config.json> <address> <partner>
//
// Build first: `npm run build` (imports from dist/).

import { readFile } from "node:fs/promises";
import { ConfigLoader } from "../dist/config.js";
import { forwardToElliptic } from "../dist/elliptic.js";
import { scoreResponse } from "../dist/scoring.js";

const [, , configPath, addressArg, partnerArg] = process.argv;
if (!configPath || !addressArg || !partnerArg) {
  console.error("usage: local-screen.mjs <config.json> <address> <partner>");
  process.exit(2);
}

const loader = new ConfigLoader(() => readFile(configPath, "utf8"));
const config = await loader.get();

// Screen with the named partner's own Elliptic credentials. The partner is
// required and never defaulted, so the script can't silently spend an
// arbitrary partner's Elliptic quota.
const partner = config.partners[partnerArg];
if (!partner) {
  console.error(`partner not found in config: ${partnerArg}`);
  process.exit(2);
}
console.error(`screening as partner: ${partnerArg}`);

const address = addressArg.toLowerCase();
const upstream = await forwardToElliptic({
  ellipticUrl: config.elliptic.url,
  ellipticKey: partner.ellipticKey,
  ellipticSecret: partner.ellipticSecret,
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
