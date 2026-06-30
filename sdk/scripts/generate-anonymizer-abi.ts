#!/usr/bin/env npx tsx
/**
 * Extracts the SubAccountAnonymizer ABI from its Cairo build artifact into a TypeScript file,
 * mirroring generate-abi.ts. Used by the SDK to compile `privacy_invoke_with_computation` calldata.
 */

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const inputPath = join(
  __dirname,
  "../../target/dev/sub_account_anonymizer_SubAccountAnonymizer.contract_class.json"
);
const outputPath = join(__dirname, "../src/internal/anonymizer-abi.ts");

interface ContractClass {
  abi: unknown[];
}

try {
  const contractClass: ContractClass = JSON.parse(readFileSync(inputPath, "utf-8"));

  const output = `/**
 * SubAccountAnonymizer Contract ABI
 *
 * This file is auto-generated from Cairo build artifacts.
 * Do not edit manually - run 'npm run generate:anonymizer-abi' to regenerate.
 */

export const SubAccountAnonymizerABI = ${JSON.stringify(contractClass.abi, null, 2)} as const;
`;

  writeFileSync(outputPath, output);
  console.log("✅ Successfully generated", outputPath);

  // Format with prettier (execFile, no shell, to avoid injection).
  execFileSync("prettier", ["--write", outputPath], { stdio: "inherit" });
} catch (error) {
  console.error("❌ Error generating anonymizer ABI:", (error as Error).message);
  process.exit(1);
}
