#!/usr/bin/env node
/* global console, process */
/**
 * Simple script to extract ABI from Cairo build artifacts and generate TypeScript file.
 * This replaces the need for abi-wan-kanabi dependency.
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const inputPath = join(__dirname, "../../target/dev/privacy_Privacy.contract_class.json");
const outputPath = join(__dirname, "../src/internal/abi.ts");

try {
  // Read the contract class JSON
  const contractClass = JSON.parse(readFileSync(inputPath, "utf-8"));

  // Generate TypeScript file with ABI as const
  const output = `/**
 * Privacy Pool Contract ABI
 *
 * This file is auto-generated from Cairo build artifacts.
 * Do not edit manually - run 'npm run generate:abi' to regenerate.
 *
 * The 'as const' assertion enables TypeScript to infer exact literal types,
 * which allows starknet.js's .typedv2() to provide full autocomplete
 * and type checking for contract methods.
 */

export const PrivacyPoolABI = ${JSON.stringify(contractClass.abi, null, 2)} as const;
`;

  writeFileSync(outputPath, output);
  console.log("✅ Successfully generated", outputPath);

  // Run prettier to ensure consistent formatting
  execSync(`prettier --write ${outputPath}`, { stdio: "inherit" });
} catch (error) {
  console.error("❌ Error generating ABI:", error.message);
  process.exit(1);
}
