#!/usr/bin/env npx tsx

/**
 * Decode Starknet contract errors from hex to readable strings
 *
 * Usage:
 *   npm run decode-error '{"revert_error":...}'
 *   npm run decode-error 0x494e56414c49445f5349474e4154555245
 *   echo '{"revert_error":...}' | npm run decode-error
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { hash } from "starknet";
import { addSelectors, decodeValue } from "../src/utils/error-decoder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load additional selectors from the Privacy pool ABI
 */
function loadAbiSelectors(): void {
  const abiPath = join(__dirname, "../src/internal/abi.ts");
  if (existsSync(abiPath)) {
    try {
      const abiContent = readFileSync(abiPath, "utf8");
      // Extract function names from ABI using regex
      const functionMatches = abiContent.matchAll(/"name":\s*"(\w+)"/g);
      const names: string[] = [];
      for (const match of functionMatches) {
        const name = match[1];
        if (name && !name.startsWith("_") && name !== "type") {
          names.push(name);
        }
      }
      addSelectors(names);
    } catch {
      // Ignore ABI loading errors
    }
  }
}

async function main(): Promise<void> {
  // Load ABI selectors before processing
  loadAbiSelectors();

  let input = process.argv[2];

  // If no argument, read from stdin
  if (!input) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    input = Buffer.concat(chunks).toString("utf8").trim();
  }

  if (!input) {
    console.log("Usage: npm run decode-error '<json-or-hex>'");
    console.log("       echo '<json>' | npm run decode-error");
    process.exit(1);
  }

  const decoded = decodeValue(input);
  console.log(JSON.stringify(decoded, null, 2));
}

main().catch(console.error);
