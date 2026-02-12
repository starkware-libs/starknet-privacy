/**
 * Script to parse Cairo test output and generate reference data JSON.
 *
 * This script reads a file containing Cairo test output and extracts
 * key-value pairs like "path.to.key: 0x123" into a JSON structure.
 *
 * Usage: npx tsx scripts/generate-cairo-refs.ts <input-file>
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesPath = join(__dirname, "../tests/fixtures/cairo-reference-data.json");

// Get input file from command line argument
const inputFile = process.argv[2];
if (!inputFile) {
  console.error("Usage: npx tsx scripts/generate-cairo-refs.ts <input-file>");
  process.exit(1);
}

// Load current fixtures (for metadata like _comment, _ttl_days)
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf-8"));

/**
 * Set a value at a JSON path (e.g., "input.sender" -> { input: { sender: value } }).
 * When a path segment is a numeric index, creates an array for the parent.
 */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    const nextIsIndex = /^\d+$/.test(nextPart);
    if (!(part in current) || typeof current[part] !== "object") {
      current[part] = nextIsIndex ? [] : {};
    }
    current = current[part];
  }
  const lastPart = parts[parts.length - 1];
  if (/^\d+$/.test(lastPart)) {
    current[parseInt(lastPart, 10)] = value;
  } else {
    current[lastPart] = value;
  }
}

/**
 * Parse a value - hex strings stay as strings, decimals become numbers
 */
function parseValue(value: string): string | number {
  if (value.startsWith("0x")) {
    return value; // Keep hex as string
  }
  const num = parseInt(value, 10);
  return isNaN(num) ? value : num;
}

/**
 * Parse Cairo output into a JSON object.
 * Expects lines like "path.to.key: 0x123" or "path.to.key: 42"
 */
function parseOutput(output: string): Record<string, unknown> | null {
  const data: Record<string, unknown> = {};
  const lineRegex = /^([a-zA-Z_][a-zA-Z0-9_.]*)\s*:\s*(0x[0-9a-fA-F]+|\d+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(output)) !== null) {
    const [, path, value] = match;
    setPath(data, path, parseValue(value));
  }

  if (Object.keys(data).length === 0) {
    return null;
  }

  return data;
}

/**
 * Update the fixtures file with Cairo values.
 */
function updateFixtures(data: Record<string, unknown>): void {
  // Preserve metadata fields
  const metadata = {
    _comment: fixtures._comment,
    _ttl_days: fixtures._ttl_days,
  };

  // Merge metadata with Cairo data
  const updated = { ...metadata, ...data };

  writeFileSync(fixturesPath, JSON.stringify(updated, null, 2) + "\n");
  console.log("Updated fixtures file:", fixturesPath);
}

// Main
const output = readFileSync(inputFile, "utf-8");
const cairoData = parseOutput(output);

if (!cairoData) {
  console.error("No key-value pairs found in Cairo output");
  process.exit(1);
}

updateFixtures(cairoData);
console.log("Done! Reference values updated.");
