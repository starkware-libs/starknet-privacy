/**
 * Proving Service Compatibility Tests
 *
 * 1. Golden fixture tests (always run) - validate SDK output format
 * 2. Live integration tests (CI only) - validate against real proving service
 *
 * Version sync: _sequencerCommit in proving-service-golden.json must match
 * SEQUENCER_COMMIT in .github/workflows/typescript-ci.yml
 */

import { describe, it, beforeAll } from "vitest";
import { constants } from "starknet";
import * as fs from "fs";
import * as path from "path";
import golden from "../fixtures/proving-service-golden.json" with { type: "json" };
import {
    buildProofFacts,
    PROOF_VERSION,
    VIRTUAL_SNOS,
    VIRTUAL_SNOS0,
    VIRTUAL_PROGRAM_HASH,
} from "../../src/utils/proof-facts.js";
import { buildTransactionPayload } from "../../src/internal/proving-service-provider.js";
import { ProvingService, PROVE_TRANSACTION_RESULT_FIELDS } from "../../src/internal/proving-service.js";

// ============================================================================
// CI Configuration Validation
// ============================================================================

/**
 * Get all local imports from a TypeScript file (recursively).
 * Only follows relative imports (./xxx or ../xxx), not external packages.
 */
function getLocalImports(filePath: string, visited = new Set<string>()): Set<string> {
    const absolutePath = path.resolve(filePath);
    if (visited.has(absolutePath)) return visited;
    if (!fs.existsSync(absolutePath)) return visited;

    visited.add(absolutePath);
    const content = fs.readFileSync(absolutePath, "utf-8");

    // Match: import ... from "./xxx" or import ... from "../xxx"
    const importRegex = /from\s+["'](\.[^"']+)["']/g;
    let match;

    while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        // Resolve the import path relative to the current file
        const dir = path.dirname(absolutePath);
        let resolved = path.resolve(dir, importPath);

        // Handle .js → .ts conversion (TypeScript imports use .js but files are .ts)
        if (resolved.endsWith(".js")) {
            resolved = resolved.replace(/\.js$/, ".ts");
        }
        if (!resolved.endsWith(".ts")) {
            resolved += ".ts";
        }

        // Recursively get imports
        getLocalImports(resolved, visited);
    }

    return visited;
}

/**
 * Check if a file path matches any of the CI filter patterns.
 */
function matchesCIFilter(filePath: string, patterns: string[], repoRoot?: string): boolean {
    // Normalize to relative path from repo root
    const root = repoRoot ?? path.resolve(__dirname, "../../..");
    const relativePath = path.relative(root, filePath).replace(/\\/g, "/");

    for (const pattern of patterns) {
        // Handle glob patterns
        if (pattern.endsWith("/**")) {
            // sdk/src/utils/** matches sdk/src/utils/anything.ts
            const prefix = pattern.slice(0, -2); // Remove ** but keep trailing /
            if (relativePath.startsWith(prefix) || relativePath === prefix.slice(0, -1)) return true;
        } else if (pattern.endsWith("/*")) {
            const prefix = pattern.slice(0, -1); // Remove * but keep trailing /
            const dir = path.dirname(relativePath) + "/";
            if (dir === prefix || dir.startsWith(prefix)) return true;
        } else if (pattern.includes("*")) {
            // Simple wildcard: proving-service*.ts matches proving-service.ts, proving-service-provider.ts
            const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
            if (regex.test(relativePath)) return true;
        } else {
            if (relativePath === pattern) return true;
        }
    }
    return false;
}

// CI configuration constants
const CI_WORKFLOW_PATH = ".github/workflows/typescript-ci.yml";
const CI_FILTER_NAME = "proving";  // The filter name in paths-filter

// Entry points: files that the proving service test exercises
// Their dependencies must be covered by the CI filter
const PROVING_SERVICE_ENTRY_POINTS = [
    "sdk/src/internal/proving-service.ts",
    "sdk/src/internal/proving-service-provider.ts",
    "sdk/src/utils/proof-facts.ts",
];

describe("CI Configuration", () => {
    it("proving service filter covers all dependencies", () => {
        // __dirname = sdk/tests/internal, repo root is 3 levels up
        const repoRoot = path.resolve(__dirname, "../../..");

        // Read CI workflow
        const ciPath = path.join(repoRoot, CI_WORKFLOW_PATH);
        const ciContent = fs.readFileSync(ciPath, "utf-8");

        // Extract filter patterns (simple YAML parsing)
        const filterKey = `${CI_FILTER_NAME}:`;
        const provingStart = ciContent.indexOf(filterKey);
        if (provingStart === -1) {
            throw new Error(`Could not find '${CI_FILTER_NAME}' filter in CI workflow`);
        }

        // Extract lines until we hit a line that starts a new section (no leading whitespace) or is blank
        const afterProving = ciContent.slice(provingStart);
        const lines = afterProving.split("\n").slice(1); // Skip the "proving:" line itself
        const patternLines: string[] = [];
        for (const line of lines) {
            // Stop at empty line or line without leading whitespace (new section)
            if (line.trim() === "" || (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t"))) {
                break;
            }
            patternLines.push(line);
        }

        // Extract patterns from lines like "- 'sdk/src/...' "
        const patterns = patternLines
            .map(line => {
                const match = line.match(/-\s+'([^']+)'/);
                return match ? match[1] : null;
            })
            .filter((p): p is string => p !== null);

        // Resolve entry points to absolute paths
        const entryPoints = PROVING_SERVICE_ENTRY_POINTS.map(p => path.join(repoRoot, p));

        // Get all dependencies
        const allDeps = new Set<string>();
        for (const entry of entryPoints) {
            getLocalImports(entry, allDeps);
        }

        // Check each dependency is covered
        const uncovered: string[] = [];

        for (const dep of allDeps) {
            if (!matchesCIFilter(dep, patterns, repoRoot)) {
                uncovered.push(path.relative(repoRoot, dep));
            }
        }

        if (uncovered.length > 0) {
            throw new Error(
                `CI filter '${CI_FILTER_NAME}' does not cover these dependencies:\n` +
                uncovered.map(f => `  - ${f}`).join("\n") +
                `\n\nAdd them to ${CI_WORKFLOW_PATH} under '${CI_FILTER_NAME}:'`
            );
        }
    });
});

// ============================================================================
// Golden Fixture Tests (Always Run - No Network Required)
// ============================================================================

// File paths for error messages
const GOLDEN_FILE = "sdk/tests/fixtures/proving-service-golden.json";
const PROOF_FACTS_FILE = "sdk/src/utils/proof-facts.ts";
const PAYLOAD_BUILDER_FILE = "sdk/src/internal/proving-service-provider.ts";

describe("Proving Service Protocol (Golden Fixture)", () => {
    it("SDK produces correct transaction payload format", () => {
        const { input, expectedOutput } = golden.transactionPayload;

        const payload = buildTransactionPayload({
            contractAddress: input.contractAddress,
            calldata: input.calldata,
            signature: input.signature,
            nonce: BigInt(input.nonce),
            resourceBounds: {
                l1_gas: {
                    max_amount: BigInt(input.resourceBounds.l1_gas.max_amount),
                    max_price_per_unit: BigInt(input.resourceBounds.l1_gas.max_price_per_unit)
                },
                l2_gas: {
                    max_amount: BigInt(input.resourceBounds.l2_gas.max_amount),
                    max_price_per_unit: BigInt(input.resourceBounds.l2_gas.max_price_per_unit)
                },
                l1_data_gas: {
                    max_amount: BigInt(input.resourceBounds.l1_data_gas.max_amount),
                    max_price_per_unit: BigInt(input.resourceBounds.l1_data_gas.max_price_per_unit)
                },
            },
            tip: BigInt(input.tip),
        });

        // Compare with helpful error message
        if (JSON.stringify(payload) !== JSON.stringify(expectedOutput)) {
            throw new Error(
                `Transaction payload format mismatch!\n\n` +
                `Expected (from ${GOLDEN_FILE}):\n${JSON.stringify(expectedOutput, null, 2)}\n\n` +
                `Actual (from buildTransactionPayload in ${PAYLOAD_BUILDER_FILE}):\n${JSON.stringify(payload, null, 2)}\n\n` +
                `To fix:\n` +
                `  - If SDK changed intentionally: update "expectedOutput" in ${GOLDEN_FILE}\n` +
                `  - If proving service changed: update buildTransactionPayload() in ${PAYLOAD_BUILDER_FILE}`
            );
        }
    });

    it("ProofFacts has correct length", () => {
        const proofFacts = buildProofFacts("0x1", [], 100n, "0x0", constants.StarknetChainId.SN_SEPOLIA);
        const expected = golden.proofFacts.expectedLength;
        const actual = proofFacts.length;

        if (actual !== expected) {
            throw new Error(
                `ProofFacts length mismatch!\n\n` +
                `Expected: ${expected} (from ${GOLDEN_FILE})\n` +
                `Actual: ${actual} (from buildProofFacts in ${PROOF_FACTS_FILE})\n\n` +
                `To fix:\n` +
                `  - If SDK changed intentionally: update "proofFacts.expectedLength" in ${GOLDEN_FILE}\n` +
                `  - If proving service changed: update buildProofFacts() in ${PROOF_FACTS_FILE}`
            );
        }
    });
});

// ============================================================================
// Live Integration Tests (Only When Proving Service is Running)
// ============================================================================

const PROVING_SERVICE_URL = process.env.PROVING_SERVICE_URL || "http://localhost:6060";

// If PROVING_SERVICE_URL is explicitly set, we're in CI and service MUST be available
// If not set, we're in local dev and can skip gracefully
const REQUIRE_SERVICE = !!process.env.PROVING_SERVICE_URL;

describe("Proving Service Integration (Live)", () => {
    // Use the actual SDK class - this tests the real code path
    const provingService = new ProvingService({
        baseUrl: PROVING_SERVICE_URL,
        requestTimeoutMs: 10_000,  // Short timeout for tests
    });
    let serviceAvailable = false;

    beforeAll(async () => {
        serviceAvailable = await provingService.isHealthy();

        if (!serviceAvailable && REQUIRE_SERVICE) {
            throw new Error(
                `Proving service not available at ${PROVING_SERVICE_URL}!\n` +
                "This test requires the proving service to be running.\n" +
                "The CI should have started it via docker-compose."
            );
        }

        if (!serviceAvailable) {
            console.log(`ℹ️ Proving service not running at ${PROVING_SERVICE_URL}`);
            console.log("   To run integration tests, start the proving service.");
        }
    });

    it("spec version matches golden", async () => {
        if (!serviceAvailable) {
            console.log("   Skipped: service not running (local dev)");
            return;
        }

        const version = await provingService.getSpecVersion();
        const expected = golden.protocolVersion;

        if (version !== expected) {
            throw new Error(
                `Protocol version mismatch!\n\n` +
                `Expected: "${expected}" (from ${GOLDEN_FILE})\n` +
                `Actual: "${version}" (from proving service at ${PROVING_SERVICE_URL})\n\n` +
                `This means the proving service protocol has changed.\n` +
                `To fix: update "protocolVersion" in ${GOLDEN_FILE} to "${version}"`
            );
        }
    });

    it("accepts SDK request format", async () => {
        if (!serviceAvailable) {
            console.log("   Skipped: service not running (local dev)");
            return;
        }

        // Build payload using actual SDK function (same as production code)
        const { input } = golden.transactionPayload;
        const payload = buildTransactionPayload({
            contractAddress: input.contractAddress,
            calldata: input.calldata,
            signature: input.signature,
            nonce: BigInt(input.nonce),
            resourceBounds: {
                l1_gas: {
                    max_amount: BigInt(input.resourceBounds.l1_gas.max_amount),
                    max_price_per_unit: BigInt(input.resourceBounds.l1_gas.max_price_per_unit)
                },
                l2_gas: {
                    max_amount: BigInt(input.resourceBounds.l2_gas.max_amount),
                    max_price_per_unit: BigInt(input.resourceBounds.l2_gas.max_price_per_unit)
                },
                l1_data_gas: {
                    max_amount: BigInt(input.resourceBounds.l1_data_gas.max_amount),
                    max_price_per_unit: BigInt(input.resourceBounds.l1_data_gas.max_price_per_unit)
                },
            },
            tip: BigInt(input.tip),
        });

        // Call proving service - must succeed to validate full compatibility
        const result = await provingService.proveTransaction("latest", payload);

        // Verify response structure - check for missing AND extra fields
        // Uses the same field list as ProveTransactionResult interface
        const expectedFields = [...PROVE_TRANSACTION_RESULT_FIELDS];
        const actualFields = Object.keys(result);

        const missingFields = expectedFields.filter(f => !(f in result) || result[f as keyof typeof result] === undefined);
        const extraFields = actualFields.filter(f => !expectedFields.includes(f));

        if (missingFields.length > 0 || extraFields.length > 0) {
            const issues = [];
            if (missingFields.length > 0) {
                issues.push(`Missing fields: ${missingFields.join(", ")}`);
            }
            if (extraFields.length > 0) {
                issues.push(`Extra fields: ${extraFields.join(", ")} (SDK might need to handle these)`);
            }
            throw new Error(
                `Proving service response structure changed!\n\n` +
                `${issues.join("\n")}\n\n` +
                `Expected fields: ${expectedFields.join(", ")}\n` +
                `Actual fields: ${actualFields.join(", ")}\n\n` +
                `Actual response: ${JSON.stringify(result, null, 2)}\n\n` +
                `To fix: update ProveTransactionResult interface in sdk/src/internal/proving-service.ts`
            );
        }

        if (!Array.isArray(result.proof_facts)) {
            throw new Error(
                `proof_facts is not an array!\n` +
                `Actual type: ${typeof result.proof_facts}\n` +
                `Actual value: ${JSON.stringify(result.proof_facts)}`
            );
        }

        if (result.proof_facts.length !== golden.proofFacts.expectedLength) {
            throw new Error(
                `proof_facts length mismatch!\n\n` +
                `Expected: ${golden.proofFacts.expectedLength} (from ${GOLDEN_FILE})\n` +
                `Actual: ${result.proof_facts.length} (from proving service)\n\n` +
                `Actual proof_facts: ${JSON.stringify(result.proof_facts, null, 2)}\n\n` +
                `To fix: update "proofFacts.expectedLength" in ${GOLDEN_FILE}`
            );
        }

        // Validate protocol constants in proof_facts
        // These MUST match between SDK and proving service for proofs to verify on L1
        // proof_facts layout: [PROOF_VERSION, VIRTUAL_SNOS, ?, VIRTUAL_SNOS0, ?, VIRTUAL_PROGRAM_HASH, ?, ?, ?]
        const facts = result.proof_facts;
        const constantChecks = [
            { index: 0, name: "PROOF_VERSION", expected: PROOF_VERSION },
            { index: 1, name: "VIRTUAL_SNOS", expected: VIRTUAL_SNOS },
            { index: 3, name: "VIRTUAL_SNOS0", expected: VIRTUAL_SNOS0 },
            { index: 5, name: "VIRTUAL_PROGRAM_HASH", expected: VIRTUAL_PROGRAM_HASH },
        ];

        for (const { index, name, expected } of constantChecks) {
            const actual = facts[index];
            if (actual !== expected) {
                throw new Error(
                    `Protocol constant mismatch at proof_facts[${index}] (${name})!\n\n` +
                    `Expected: "${expected}" (from ${PROOF_FACTS_FILE})\n` +
                    `Actual: "${actual}" (from proving service)\n\n` +
                    `Full proof_facts from service: ${JSON.stringify(facts, null, 2)}\n\n` +
                    `This means the proving service uses a different ${name}.\n` +
                    `To fix: update ${name} in ${PROOF_FACTS_FILE} to "${actual}"`
                );
            }
        }
    });
});
