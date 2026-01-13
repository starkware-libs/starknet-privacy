/**
 * Tests that TypeScript hash implementations match Cairo implementations.
 *
 * This test uses pre-computed reference values from Cairo stored in:
 *   tests/fixtures/cairo-reference-hashes.json
 *
 * If values are stale (> _ttl_days old) or missing, the test will attempt
 * to regenerate them by running Cairo via scripts/generate-cairo-refs.ts
 */

import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { hashes } from "../../src/utils/hashes.js";

// Paths
const fixturesPath = join(__dirname, "../fixtures/cairo-reference-hashes.json");
const generatorScript = join(__dirname, "../../scripts/generate-cairo-refs.ts");

// Check if reference values are stale or missing
function isStaleOrMissing(): { stale: boolean; reason: string } {
  if (!existsSync(fixturesPath)) {
    return { stale: true, reason: "Fixtures file does not exist" };
  }

  const data = JSON.parse(readFileSync(fixturesPath, "utf-8"));

  if (!data._generated) {
    return { stale: true, reason: "No _generated timestamp" };
  }

  const generated = new Date(data._generated);
  const now = new Date();
  const ageInDays = (now.getTime() - generated.getTime()) / (1000 * 60 * 60 * 24);
  const ttl = data._ttl_days || 1;

  if (ageInDays > ttl) {
    return { stale: true, reason: `Data is ${ageInDays.toFixed(1)} days old (TTL: ${ttl})` };
  }

  // Check if any output values are null
  for (const [key, value] of Object.entries(data.outputs || {})) {
    if (value === null) {
      return { stale: true, reason: `Output "${key}" is null` };
    }
  }

  return { stale: false, reason: "" };
}

// Check if Cairo tools (snforge) are available
function isCairoAvailable(): boolean {
  try {
    const version = execSync("snforge --version", { encoding: "utf-8", stdio: "pipe" }).trim();
    console.log(`Cairo tools available: snforge ${version}`);
    return true;
  } catch {
    console.log("Cairo tools (snforge) not found in PATH");
    return false;
  }
}

// Check if regeneration should be attempted
function shouldRegenerateCairo(): boolean {
  // If explicitly requested, always try
  if (process.env.CAIRO_REGENERATE) {
    return true;
  }
  // In CI, only try if Cairo tools are available
  if (process.env.CI) {
    console.log("Running in CI, checking for Cairo tools...");
    return isCairoAvailable();
  }
  // Local without CAIRO_REGENERATE - don't regenerate
  console.log("Skipping Cairo regeneration (set CAIRO_REGENERATE=1 to force)");
  return false;
}

// Try to regenerate Cairo reference values
function regenerateCairoRefs(): boolean {
  if (!shouldRegenerateCairo()) {
    const reason = process.env.CI
      ? "Cairo tools not available in CI"
      : "not in CI, set CAIRO_REGENERATE=1 to force";
    console.log(`Skipping Cairo regeneration (${reason})`);
    return false;
  }

  // Check if generator script exists
  if (!existsSync(generatorScript)) {
    console.warn("Generator script not found:", generatorScript);
    return false;
  }

  console.log("Regenerating Cairo reference values...");
  console.log(`Running: npx tsx ${generatorScript}`);
  try {
    const output = execSync(`npx tsx ${generatorScript}`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 180000, // 3 minute timeout for CI
    });
    console.log("Generator output:", output);
    return true;
  } catch (error: unknown) {
    // Log full error details for debugging
    if (error && typeof error === "object" && "stderr" in error) {
      console.error("Generator stderr:", (error as { stderr: string }).stderr);
    }
    if (error && typeof error === "object" && "stdout" in error) {
      console.error("Generator stdout:", (error as { stdout: string }).stdout);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("Cairo regeneration failed:", message);
    return false;
  }
}

function loadFixtures() {
  return JSON.parse(readFileSync(fixturesPath, "utf-8"));
}

// Check staleness at module load time (for test naming)
const initialStaleCheck = isStaleOrMissing();
const isUsingStaleData = initialStaleCheck.stale;

// Helper to add stale warning to test name
const testName = (name: string) => (isUsingStaleData ? `${name} (⚠️ STALE DATA)` : name);

// State - will be populated in beforeAll
let referenceData: ReturnType<typeof loadFixtures>;
let hasValidRefs = false;
let skipReason = "";

describe("Cairo compatibility", () => {
  beforeAll(() => {
    const { stale, reason } = initialStaleCheck;
    const forceRegenerate = Boolean(process.env.CAIRO_REGENERATE);

    // Regenerate if stale OR explicitly requested
    if (stale || forceRegenerate) {
      if (forceRegenerate) {
        console.log("CAIRO_REGENERATE is set, forcing regeneration...");
      } else {
        console.log(`Cairo reference data is stale: ${reason}`);
      }

      const regenerated = regenerateCairoRefs();

      if (regenerated) {
        // Reload the fixtures after regeneration
        referenceData = loadFixtures();
        hasValidRefs = true;
        return;
      }

      // Regeneration failed or skipped - try to use cached data
      try {
        referenceData = loadFixtures();
        const hasOutputs = Object.values(referenceData.outputs || {}).some((v) => v !== null);
        if (hasOutputs) {
          console.log(`Using cached Cairo refs (STALE). Run with CAIRO_REGENERATE=1 to refresh.`);
          hasValidRefs = true;
        } else {
          skipReason = `Cairo refs missing. Run: CAIRO_REGENERATE=1 npm test`;
          hasValidRefs = false;
        }
      } catch {
        skipReason = `Cairo refs unavailable: ${reason}`;
        hasValidRefs = false;
      }
    } else {
      referenceData = loadFixtures();
      hasValidRefs = true;
    }
  }, 180000); // 3 minute timeout for Cairo regeneration in CI

  describe("hash output comparison", () => {
    it(testName("channelKey matches Cairo compute_channel_key"), () => {
      expect(hasValidRefs, skipReason).toBe(true);
      const { inputs, outputs } = referenceData;
      const result = hashes.channelKey(
        inputs.sender,
        inputs.senderPrivateKey,
        inputs.recipient,
        inputs.recipientPublicKey
      );
      expect("0x" + result.toString(16)).toBe(outputs.channelKey);
    });

    it(testName("channelId matches Cairo compute_channel_id"), () => {
      expect(hasValidRefs, skipReason).toBe(true);
      const { inputs, outputs } = referenceData;
      const result = hashes.channelId(
        inputs.channelKey,
        inputs.sender,
        inputs.recipient,
        inputs.recipientPublicKey
      );
      expect("0x" + result.toString(16)).toBe(outputs.channelId);
    });

    it(testName("subchannelKey matches Cairo compute_subchannel_key"), () => {
      expect(hasValidRefs, skipReason).toBe(true);
      const { inputs, outputs } = referenceData;
      // Cairo uses (index, 0), TypeScript uses (slot, sequence)
      // With slot=index, sequence=0, they match
      const result = hashes.subchannelKey(inputs.channelKey, inputs.index);
      expect("0x" + result.toString(16)).toBe(outputs.subchannelKey);
    });

    it(testName("subchannelId matches Cairo compute_subchannel_id"), () => {
      expect(hasValidRefs, skipReason).toBe(true);
      const { inputs, outputs } = referenceData;
      const result = hashes.subchannelId(
        inputs.channelKey,
        inputs.recipient,
        inputs.recipientPublicKey,
        inputs.token
      );
      expect("0x" + result.toString(16)).toBe(outputs.subchannelId);
    });

    it(testName("noteId matches Cairo compute_note_id"), () => {
      expect(hasValidRefs, skipReason).toBe(true);
      const { inputs, outputs } = referenceData;
      // Cairo uses (index, 0), TypeScript uses (slot, sequence)
      // With slot=index, sequence=0, they match
      const result = hashes.noteId(inputs.channelKey, inputs.token, inputs.index);
      expect("0x" + result.toString(16)).toBe(outputs.noteId);
    });

    it(testName("nullifier matches Cairo compute_nullifier"), () => {
      expect(hasValidRefs, skipReason).toBe(true);
      const { inputs, outputs } = referenceData;
      // Cairo uses (index, 0), TypeScript uses (slot, sequence)
      // With slot=index, sequence=0, they match
      const result = hashes.nullifier(
        inputs.channelKey,
        inputs.token,
        inputs.index,
        inputs.senderPrivateKey
      );
      expect("0x" + result.toString(16)).toBe(outputs.nullifier);
    });
  });
});
