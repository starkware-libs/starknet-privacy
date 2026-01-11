/**
 * Script to generate Cairo reference hash values for TypeScript compatibility tests.
 *
 * Usage: npx tsx scripts/generate-cairo-refs.ts
 *
 * This script:
 * 1. Runs Cairo code that outputs key-value pairs like "path.to.key: 0x123"
 * 2. Parses these into a JSON structure and updates tests/fixtures/cairo-reference-hashes.json
 *
 * The TypeScript tests will automatically call this if values are stale.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesPath = join(__dirname, "../tests/fixtures/cairo-reference-hashes.json");
const cairoProjectPath = join(__dirname, "../../packages/privacy");

// Load current fixtures (for metadata like _comment, _ttl_days)
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf-8"));

/**
 * Set a value at a JSON path (e.g., "input.sender" -> { input: { sender: value } })
 */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
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
 * Run Cairo and parse output into a JSON object.
 * Expects lines like "path.to.key: 0x123" or "path.to.key: 42"
 */
function runCairo(): Record<string, unknown> | null {
  try {
    console.log("Running Cairo in:", cairoProjectPath);

    const result = execSync(
      `cd ${cairoProjectPath} && snforge test generate_reference_hashes --include-ignored 2>&1`,
      { encoding: "utf-8", timeout: 120000 }
    );

    console.log("Cairo output:", result);

    // Parse all "key: value" lines
    const data: Record<string, unknown> = {};
    const lineRegex = /^([a-zA-Z_][a-zA-Z0-9_.]*)\s*:\s*(0x[0-9a-fA-F]+|\d+)$/gm;

    let match;
    while ((match = lineRegex.exec(result)) !== null) {
      const [, path, value] = match;
      setPath(data, path, parseValue(value));
    }

    if (Object.keys(data).length === 0) {
      console.error("No key-value pairs found in Cairo output");
      return null;
    }

    return data;
  } catch (error) {
    console.error("Failed to run Cairo:", error);
    return null;
  }
}

/**
 * Update the fixtures file with Cairo values.
 */
function updateFixtures(data: Record<string, unknown>): void {
  // Preserve metadata fields
  const metadata = {
    _comment: fixtures._comment,
    _ttl_days: fixtures._ttl_days,
    _generated: new Date().toISOString().split("T")[0], // YYYY-MM-DD
  };

  // Merge metadata with Cairo data
  const updated = { ...metadata, ...data };

  writeFileSync(fixturesPath, JSON.stringify(updated, null, 2) + "\n");
  console.log("Updated fixtures file:", fixturesPath);
}

// Main
console.log("Generating Cairo reference hashes...");

const cairoData = runCairo();

if (cairoData) {
  updateFixtures(cairoData);
  console.log("Done! Reference values updated.");
} else {
  console.error("Failed to generate Cairo reference values.");
  process.exit(1);
}
