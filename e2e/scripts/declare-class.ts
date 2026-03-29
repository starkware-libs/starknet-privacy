/**
 * Declare the privacy pool contract class on a live network (e.g. Sepolia).
 *
 * Reads env vars:
 *   VITE_RPC_URL        — JSON-RPC endpoint
 *   ACCOUNTS       — JSON array of accounts (admin has "admin": true)
 *
 * Loads sierra + casm artifacts from target/release/ and submits a DECLARE v3 tx.
 *
 * Usage: npm run declare-class   (from e2e/, with .env populated)
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Account, RpcProvider, hash } from "starknet";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");

const CONTRACT_CLASS_PATH = join(
  repoRoot,
  "target/release/privacy_Privacy.contract_class.json",
);
const COMPILED_CONTRACT_PATH = join(
  repoRoot,
  "target/release/privacy_Privacy.compiled_contract_class.json",
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

interface AccountEntry {
  name: string;
  address: string;
  privateKey: string;
  admin?: boolean;
}

const rpcUrl = requireEnv("VITE_RPC_URL");
const allAccounts: AccountEntry[] = JSON.parse(requireEnv("ACCOUNTS"));
const admin = allAccounts.find((a) => a.admin);
if (!admin) throw new Error("No admin account (admin: true) found in ACCOUNTS");

const provider = new RpcProvider({ nodeUrl: rpcUrl });
const adminAccount = new Account({
  provider,
  address: admin.address,
  signer: admin.privateKey,
  cairoVersion: "1",
});

console.log("Loading contract artifacts...");
const contractClass = JSON.parse(readFileSync(CONTRACT_CLASS_PATH, "utf8"));
const compiledContract = JSON.parse(
  readFileSync(COMPILED_CONTRACT_PATH, "utf8"),
);

const classHash = hash.computeContractClassHash(contractClass);
console.log("Class hash:", classHash);

// Check if already declared before sending a tx
try {
  await provider.getClass(classHash);
  console.log("Class already declared on-chain — nothing to do.");
  console.log("Update VITE_POOL_CLASS_HASH in .env to:", classHash);
  process.exit(0);
} catch {
  // getClass throws when the class doesn't exist — proceed with declaration
}

console.log("Estimating fee...");
const feeEstimate = await adminAccount.estimateDeclareFee({
  contract: contractClass,
  casm: compiledContract,
});
console.log("Submitting DECLARE transaction...");
try {
  const response = await adminAccount.declare(
    { contract: contractClass, casm: compiledContract },
    { resourceBounds: feeEstimate.resourceBounds, tip: 1n },
  );

  console.log("Transaction hash:", response.transaction_hash);
  console.log("Waiting for acceptance...");

  const receipt = await provider.waitForTransaction(response.transaction_hash);
  if (!receipt.isSuccess()) {
    console.error("DECLARE failed:", JSON.stringify(receipt, null, 2));
    process.exit(1);
  }

  console.log("Class declared successfully!");
  console.log("Class hash:", response.class_hash);
} catch (error: unknown) {
  // RpcError dumps the full sierra payload — extract just the useful info
  if (error instanceof Error && "code" in error) {
    const rpcError = error as Error & {
      code: number;
      data?: unknown;
      baseError?: unknown;
    };
    if (rpcError.code === 51) {
      console.log("Class already declared — nothing to do.");
      console.log("Update VITE_POOL_CLASS_HASH in .env to:", classHash);
    } else {
      console.error("RPC error code:", rpcError.code);
      console.error(
        "RPC error message:",
        rpcError.message.split(" with params")[0],
      );
      if (rpcError.data)
        console.error("RPC error data:", JSON.stringify(rpcError.data));
      if (rpcError.baseError)
        console.error("RPC base error:", JSON.stringify(rpcError.baseError));
      process.exit(1);
    }
  } else {
    console.error("Error:", error);
    process.exit(1);
  }
}
