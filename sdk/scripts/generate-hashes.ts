/**
 * Script to translate packages/privacy/src/hashes.cairo to TypeScript.
 *
 * This script reads the Cairo hashes file and generates an equivalent TypeScript file,
 * keeping function names identical (snake_case) for 1:1 correspondence.
 *
 * Usage: npx tsx scripts/generate-hashes.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cairoHashesPath = join(__dirname, "../../packages/privacy/src/hashes.cairo");
const tsHashesPath = join(__dirname, "../src/utils/hashes.ts");

// Read the Cairo file
console.log("Reading Cairo source:", cairoHashesPath);
const cairoSource = readFileSync(cairoHashesPath, "utf-8");

// ============ Extract domain separation constants ============
const constantRegex = /pub\s+const\s+(\w+):\s*felt252\s*=\s*'([^']+)'/g;
const constants: Array<{ name: string; value: string }> = [];
let match: RegExpExecArray | null;

while ((match = constantRegex.exec(cairoSource)) !== null) {
  const [, name, value] = match;
  constants.push({ name, value });
}

console.log(`Found ${constants.length} domain separation constants`);

// ============ Extract function definitions ============
interface FunctionDef {
  name: string;
  params: Array<{ name: string; cairoType: string }>;
  hashArgs: string[];
}

const functions: FunctionDef[] = [];

// Match all pub(crate) fn definitions that return felt252 and call hash()
const functionRegex =
  /pub\(crate\)\s+fn\s+(\w+)\s*\(\s*([\s\S]*?)\s*\)\s*->\s*felt252\s*\{([\s\S]*?)\n\}/g;

let funcMatch: RegExpExecArray | null;
while ((funcMatch = functionRegex.exec(cairoSource)) !== null) {
  const [, name, paramsStr, bodyStr] = funcMatch;

  // Skip the generic hash function
  if (name === "hash") continue;

  // Parse parameters - handle multi-line params
  const params: Array<{ name: string; cairoType: string }> = [];
  const cleanParams = paramsStr.replace(/\s+/g, " ").trim();
  if (cleanParams) {
    // Split by comma, but be careful with nested types
    const paramParts = cleanParams.split(",").map((p) => p.trim());
    for (const part of paramParts) {
      if (!part) continue;
      const paramMatch = part.match(/(\w+):\s*(.+)/);
      if (paramMatch) {
        params.push({ name: paramMatch[1], cairoType: paramMatch[2].trim() });
      }
    }
  }

  // Extract the hash call arguments
  // Look for hash([...].span()) or hash(\n[...]\n.span())
  const hashCallMatch = bodyStr.match(/hash\s*\(\s*\[([\s\S]*?)\]\s*\.span\(\)\s*,?\s*\)/);
  if (!hashCallMatch) continue;

  // Parse the arguments from the array literal
  const argsStr = hashCallMatch[1];
  // Clean up and split
  const args = argsStr
    .replace(/\s+/g, " ")
    .trim()
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a);

  functions.push({
    name,
    params,
    hashArgs: args,
  });
}

console.log(`Found ${functions.length} hash functions`);

// ============ Generate TypeScript ============

function cairoTypeToTs(cairoType: string): string {
  if (cairoType === "ContractAddress") return "bigint";
  if (cairoType === "felt252") return "bigint";
  if (cairoType === "usize") return "number";
  if (cairoType === "u128") return "bigint";
  return "bigint";
}

function translateArg(arg: string): string {
  // Replace Cairo-specific syntax with TypeScript
  return (
    arg
      // Remove .into() calls
      .replace(/\.into\(\)/g, "")
      // Replace Zero::zero() with 0n
      .replace(/Zero::zero\(\)/g, "0n")
      .trim()
  );
}

// Build the TypeScript file
const tsLines: string[] = [];

// Header
tsLines.push(`/**
 * Hash utility functions for privacy operations.
 * AUTO-GENERATED from packages/privacy/src/hashes.cairo
 * To regenerate: npx tsx scripts/generate-hashes.ts
 */

import { hash } from "./crypto.js";
`);

// Collect all constants used by the hash functions
const usedConstants = new Set<string>();
for (const func of functions) {
  for (const arg of func.hashArgs) {
    const translated = translateArg(arg);
    // Check if this arg is a constant (all caps with underscores)
    if (/^[A-Z_]+$/.test(translated)) {
      usedConstants.add(translated);
    }
  }
}

// Domain separation constants (only those actually used)
tsLines.push("// Domain separation tags (from Cairo domain_separation module)");
for (const { name, value } of constants) {
  if (usedConstants.has(name)) {
    tsLines.push(`const ${name} = "${value}";`);
  }
}
tsLines.push("");

// Hash functions
for (const func of functions) {
  // Generic comment pointing to Cairo source for documentation
  tsLines.push("/** See packages/privacy/src/hashes.cairo for documentation. */");

  // Function signature
  const tsParams = func.params.map((p) => `${p.name}: ${cairoTypeToTs(p.cairoType)}`).join(", ");

  // Function body - translate each argument
  const tsArgs = func.hashArgs.map(translateArg).join(", ");

  tsLines.push(`export function ${func.name}(${tsParams}): bigint {`);
  tsLines.push(`  return hash(${tsArgs});`);
  tsLines.push("}");
  tsLines.push("");
}

const tsContent = tsLines.join("\n");

// Write the file
writeFileSync(tsHashesPath, tsContent);
console.log("Generated:", tsHashesPath);

// Summary
console.log("\nGenerated functions:");
for (const func of functions) {
  console.log(`  ${func.name}(${func.params.map((p) => p.name).join(", ")})`);
}
