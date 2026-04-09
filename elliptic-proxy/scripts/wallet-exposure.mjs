#!/usr/bin/env node
// Run a wallet_exposure analysis against Elliptic for a single address.
// Reuses forwardToElliptic from the proxy so signing/body shape stay in sync.
//
// Usage:
//   ELLIPTIC_KEY=... ELLIPTIC_SECRET=<base64>       node scripts/wallet-exposure.mjs <address>
//   ELLIPTIC_KEY=... ELLIPTIC_SECRET_HEX=<hex>      node scripts/wallet-exposure.mjs <address>
//
// Optional env:
//   ELLIPTIC_URL       default https://aml-api.elliptic.co
//   ELLIPTIC_TIMEOUT   default 30000 (ms)
//
// Build first: `npm run build` (script imports from dist/).

import { forwardToElliptic } from "../dist/elliptic.js";

const address = process.argv[2];
if (!address) {
  console.error("usage: wallet-exposure.mjs <address>");
  process.exit(2);
}

const ellipticKey = process.env.ELLIPTIC_KEY;
const secretHex = process.env.ELLIPTIC_SECRET_HEX;
const ellipticSecret = secretHex
  ? Buffer.from(secretHex.replace(/^0x/, ""), "hex").toString("base64")
  : process.env.ELLIPTIC_SECRET;
if (!ellipticKey || !ellipticSecret) {
  console.error(
    "ELLIPTIC_KEY and ELLIPTIC_SECRET (base64) or ELLIPTIC_SECRET_HEX must be set"
  );
  process.exit(2);
}

const { status, body, durationMs } = await forwardToElliptic({
  ellipticUrl: process.env.ELLIPTIC_URL ?? "https://aml-api.elliptic.co",
  ellipticKey,
  ellipticSecret,
  ellipticTimeoutMs: Number(process.env.ELLIPTIC_TIMEOUT ?? 30000),
  address,
});

console.error(`HTTP ${status}  (${durationMs} ms)`);
try {
  console.log(JSON.stringify(JSON.parse(body), null, 2));
} catch {
  console.log(body);
}
process.exit(status >= 200 && status < 300 ? 0 : 1);
