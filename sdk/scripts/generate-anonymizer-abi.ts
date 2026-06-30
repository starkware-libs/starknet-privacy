#!/usr/bin/env npx tsx
/**
 * Extracts the SubAccountAnonymizer ABI from its Cairo build artifact into a TypeScript file,
 * mirroring generate-abi.ts. Used by the SDK to compile `privacy_invoke_with_computation` calldata.
 */

import { generateContractAbi } from "./generate-contract-abi.js";

generateContractAbi({
  scriptUrl: import.meta.url,
  inputPathFromScriptsDir:
    "../../target/dev/sub_account_anonymizer_SubAccountAnonymizer.contract_class.json",
  outputPathFromScriptsDir: "../src/internal/anonymizer-abi.ts",
  contractName: "SubAccountAnonymizer",
  exportName: "SubAccountAnonymizerABI",
  regenerateCommand: "npm run generate:anonymizer-abi",
  errorLabel: "anonymizer ABI",
});
