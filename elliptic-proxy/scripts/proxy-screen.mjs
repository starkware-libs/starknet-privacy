#!/usr/bin/env node
// Call the deployed elliptic-proxy Cloud Function for a single address.
// Signs the request as a partner using the same HMAC scheme the proxy verifies.
//
// Usage:
//   PARTNER_NAME=acme PARTNER_SECRET=<base64> \
//     node scripts/proxy-screen.mjs <proxy-url> <address>
//   PARTNER_NAME=acme PARTNER_SECRET_HEX=<hex> \
//     node scripts/proxy-screen.mjs <proxy-url> <address>
//
// Build first: `npm run build` (imports computeHmacSignature from dist/).

import { computeHmacSignature } from "../dist/auth.js";

const [, , proxyUrlArg, address] = process.argv;
if (!proxyUrlArg || !address) {
  console.error("usage: proxy-screen.mjs <proxy-url> <address>");
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

const proxyUrl = new URL(proxyUrlArg);
// Cloud Functions (cloudfunctions.net/<name>) strips the function-name segment
// before dispatching to the container, so the server always sees req.path="/".
// Override with PROXY_SIGN_PATH if you deploy behind a path-preserving gateway.
const path = process.env.PROXY_SIGN_PATH ?? "/";
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
