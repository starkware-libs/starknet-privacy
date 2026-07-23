#!/usr/bin/env npx tsx
/**
 * Simple script to extract ABI from Cairo build artifacts and generate TypeScript file.
 * This replaces the need for abi-wan-kanabi dependency.
 */

import { generateContractAbi } from "./generate-contract-abi.js";

generateContractAbi({
  scriptUrl: import.meta.url,
  inputPathFromScriptsDir: "../../target/dev/privacy_Privacy.contract_class.json",
  outputPathFromScriptsDir: "../src/internal/abi.ts",
  contractName: "Privacy Pool",
  exportName: "PrivacyPoolABI",
  regenerateCommand: "npm run generate:abi",
  errorLabel: "ABI",
  extraHeaderLines: [
    "The 'as const' assertion enables TypeScript to infer exact literal types,",
    "which allows starknet.js's .typedv2() to provide full autocomplete",
    "and type checking for contract methods.",
  ],
});
