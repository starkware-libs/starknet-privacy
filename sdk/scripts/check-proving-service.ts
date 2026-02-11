#!/usr/bin/env npx tsx
/**
 * Check that the Proving Service is reachable and returns a spec version.
 * Usage:
 *   npx tsx scripts/check-proving-service.ts
 *   npx tsx scripts/check-proving-service.ts http://136.115.124.93:3000
 */

import { ProvingServiceClient } from "../src/internal/proving-service/index.js";

const baseUrl = process.argv[2] ?? "http://136.115.124.93:3000";

async function main() {
  const client = new ProvingServiceClient({ baseUrl, timeoutMs: 10_000 });
  console.log(`Checking proving service at ${baseUrl} ...`);

  try {
    const version = await client.getSpecVersion();
    console.log(`OK – starknet_specVersion: ${version}`);
    process.exit(0);
  } catch (err) {
    console.error("Failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
