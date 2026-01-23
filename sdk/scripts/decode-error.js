#!/usr/bin/env node

/**
 * Decode Starknet contract errors from hex to readable strings
 *
 * Usage:
 *   npm run decode-error '{"revert_error":...}'
 *   npm run decode-error 0x494e56414c49445f5349474e4154555245
 *   echo '{"revert_error":...}' | npm run decode-error
 */

import { hash } from "starknet";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Common Starknet function names to build selector lookup
const COMMON_FUNCTIONS = [
  // Account functions
  "__execute__",
  "__validate__",
  "__validate_declare__",
  "__validate_deploy__",
  "is_valid_signature",
  "get_nonce",
  // ERC20
  "transfer",
  "transfer_from",
  "approve",
  "balance_of",
  "allowance",
  "total_supply",
  "name",
  "symbol",
  "decimals",
  // ERC721
  "owner_of",
  "safe_transfer_from",
  "set_approval_for_all",
  "get_approved",
  "is_approved_for_all",
  // Outside execution (SNIP-9)
  "execute_from_outside",
  "execute_from_outside_v2",
  "is_valid_outside_execution_nonce",
  // Ownable
  "owner",
  "transfer_ownership",
  "renounce_ownership",
  // Upgradeable
  "upgrade",
  // Access control
  "has_role",
  "grant_role",
  "revoke_role",
  // Privacy pool specific
  "register",
  "deposit",
  "withdraw",
  "transfer",
  "get_public_key",
  "set_viewing_key",
  "get_note",
  "get_nullifier",
  "get_channel",
];

// Build selector -> name map
const selectorToName = new Map();

function buildSelectorMap() {
  // Add common functions
  for (const name of COMMON_FUNCTIONS) {
    const selector = hash.getSelectorFromName(name);
    selectorToName.set(selector, name);
  }

  // Try to load Privacy pool ABI for additional selectors
  const abiPath = join(__dirname, "../src/internal/abi.ts");
  if (existsSync(abiPath)) {
    try {
      const abiContent = readFileSync(abiPath, "utf8");
      // Extract function names from ABI using regex
      const functionMatches = abiContent.matchAll(/"name":\s*"(\w+)"/g);
      for (const match of functionMatches) {
        const name = match[1];
        if (name && !name.startsWith("_") && name !== "type") {
          const selector = hash.getSelectorFromName(name);
          if (!selectorToName.has(selector)) {
            selectorToName.set(selector, name);
          }
        }
      }
    } catch {
      // Ignore ABI loading errors
    }
  }
}

function lookupSelector(selectorHex) {
  // Normalize to lowercase for comparison
  const normalized = selectorHex.toLowerCase();

  // Try direct lookup
  if (selectorToName.has(normalized)) {
    return selectorToName.get(normalized);
  }

  // Try matching without 0x prefix padding differences
  const selectorBigInt = BigInt(selectorHex);
  for (const [key, name] of selectorToName.entries()) {
    if (BigInt(key) === selectorBigInt) {
      return name;
    }
  }

  return null;
}

function hexToString(hex) {
  if (!hex || typeof hex !== "string") return hex;
  if (!hex.startsWith("0x")) return hex;

  const cleanHex = hex.slice(2);
  // Check if it looks like ASCII (all bytes in printable range)
  let str = "";
  for (let i = 0; i < cleanHex.length; i += 2) {
    const charCode = parseInt(cleanHex.substr(i, 2), 16);
    if (charCode >= 32 && charCode <= 126) {
      str += String.fromCharCode(charCode);
    } else {
      return hex; // Not ASCII, return original
    }
  }
  return str || hex;
}

function decodeErrorArray(arr) {
  return arr.map((item) => {
    const decoded = hexToString(item);
    return decoded !== item ? `${decoded} (${item})` : item;
  });
}

function decodeError(obj) {
  if (typeof obj === "string") {
    // Try to parse as JSON
    try {
      obj = JSON.parse(obj);
    } catch {
      // Single hex value
      const decoded = hexToString(obj);
      return decoded !== obj ? `${decoded} (${obj})` : obj;
    }
  }

  if (Array.isArray(obj)) {
    return decodeErrorArray(obj);
  }

  if (typeof obj === "object" && obj !== null) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === "selector" && typeof value === "string") {
        // Look up selector name
        const funcName = lookupSelector(value);
        result[key] = funcName ? `${funcName} (${value})` : value;
      } else if (key === "error" && typeof value === "string" && value.startsWith("[")) {
        // Parse array string like "[\"0x...\",\"0x...\"]"
        try {
          const arr = JSON.parse(value);
          result[key] = decodeErrorArray(arr);
        } catch {
          result[key] = decodeError(value);
        }
      } else {
        result[key] = decodeError(value);
      }
    }
    return result;
  }

  return obj;
}

async function main() {
  // Build selector map before processing
  buildSelectorMap();

  let input = process.argv[2];

  // If no argument, read from stdin
  if (!input) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    input = Buffer.concat(chunks).toString("utf8").trim();
  }

  if (!input) {
    console.log("Usage: npm run decode-error '<json-or-hex>'");
    console.log("       echo '<json>' | npm run decode-error");
    process.exit(1);
  }

  const decoded = decodeError(input);
  console.log(JSON.stringify(decoded, null, 2));
}

main().catch(console.error);
