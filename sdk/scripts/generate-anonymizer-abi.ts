#!/usr/bin/env npx tsx
/**
 * Extracts the ShadowAccountAnonymizer ABI from its Cairo build artifact into a TypeScript file,
 * mirroring generate-abi.ts. Used by the SDK to compile `privacy_invoke_with_computation` calldata.
 */

import { generateContractAbi } from "./generate-contract-abi.js";

generateContractAbi({
  scriptUrl: import.meta.url,
  inputPathFromScriptsDir:
    "../../target/dev/shadow_account_anonymizer_ShadowAccountAnonymizer.contract_class.json",
  outputPathFromScriptsDir: "../src/internal/anonymizer-abi.ts",
  contractName: "ShadowAccountAnonymizer",
  exportName: "ShadowAccountAnonymizerABI",
  regenerateCommand: "npm run generate:anonymizer-abi",
  errorLabel: "anonymizer ABI",
});
