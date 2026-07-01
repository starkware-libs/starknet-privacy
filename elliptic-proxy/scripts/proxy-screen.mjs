#!/usr/bin/env node
// Call the deployed elliptic-proxy Cloud Function for a single address.
// Signs the request as a partner using the same HMAC scheme the proxy verifies.
//
// Usage (path defaults to "/screen", matching the proof-interceptor):
//   PARTNER_NAME=acme PARTNER_SECRET=<base64> \
//     node scripts/proxy-screen.mjs <proxy-url> <address> [path]
//   PARTNER_NAME=acme PARTNER_SECRET_HEX=<hex> \
//     node scripts/proxy-screen.mjs <proxy-url> <address> [path]
//
// Build first: `npm run build` (imports computeHmacSignature from dist/).

import { computeHmacSignature } from "../dist/auth.js";

const [, , proxyUrlArg, address, pathArg] = process.argv;
if (!proxyUrlArg || !address) {
  console.error("usage: proxy-screen.mjs <proxy-url> <address> [path]");
  process.exit(2);
}

const partnerName = process.env.PARTNER_NAME;
const secretHex = process.env.PARTNER_SECRET_HEX;
const partnerSecret = secretHex
  ? Buffer.from(secretHex.replace(/^0x/, ""), "hex").toString("base64")
  : process.env.PARTNER_SECRET;
if (!partnerName || !partnerSecret) {
  console.error(
    "PARTNER_NAME and PARTNER_SECRET (base64) or PARTNER_SECRET_HEX must be set"
  );
  process.exit(2);
}

// Append the path to the base URL and sign it, like the proof-interceptor.
// Defaults to "/screen"; pass the optional path arg (leading "/") to override.
const path = pathArg ?? "/screen";
const proxyUrl = new URL(proxyUrlArg.replace(/\/+$/, "") + path);
const body = JSON.stringify({ address });
const timestamp = Date.now().toString();
const signature = computeHmacSignature(
  partnerSecret,
  timestamp,
  "POST",
  path,
  body
);

const started = Date.now();
const response = await fetch(proxyUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-access-key": partnerName,
    "x-access-sign": signature,
    "x-access-timestamp": timestamp,
  },
  body,
});
const text = await response.text();
console.error(`HTTP ${response.status}  (${Date.now() - started} ms)`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
process.exit(response.ok ? 0 : 1);
