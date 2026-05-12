/**
 * Declare + deploy the privacy pool contract on a live network (e.g. Sepolia).
 *
 * Reads env vars:
 *   VITE_RPC_URL              — JSON-RPC endpoint
 *   ACCOUNTS                  — JSON array of accounts. Admin entry has "admin": true.
 *   VITE_COMPLIANCE_PUBLIC_KEY  — auditor public key (defaults to 0x1 for testing)
 *   VITE_PROOF_VALIDITY_BLOCKS — proof validity window (defaults to 450)
 *   DEPLOY_SALT               — contract address salt (defaults to a random 252-bit felt)
 *
 * Usage:
 *   cd e2e && npm run deploy-privacy-pool
 *
 * Prints:
 *   - declared class hash
 *   - deployed pool address
 *   Suitable for pasting into demo/.env.testnet.local as
 *   VITE_POOL_CLASS_HASH and VITE_POOL_ADDRESS.
 */

import { Account, Contract, RpcProvider, num } from "starknet";
import { declarePoolClass } from "../src/harness.js";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";

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

const auditorPublicKey = process.env.VITE_COMPLIANCE_PUBLIC_KEY ?? "0x1";
const proofValidityBlocks = process.env.VITE_PROOF_VALIDITY_BLOCKS ?? "450";
const salt =
  process.env.DEPLOY_SALT ??
  num.toHex(BigInt(Math.floor(Math.random() * 1e15)));

const provider = new RpcProvider({ nodeUrl: rpcUrl });
const adminAccount = new Account({
  provider,
  address: admin.address,
  signer: admin.privateKey,
  cairoVersion: "1",
});

console.log("[deploy-privacy-pool] rpc:", rpcUrl);
console.log("[deploy-privacy-pool] admin:", admin.address);
console.log("[deploy-privacy-pool] auditor pubkey:", auditorPublicKey);
console.log(
  "[deploy-privacy-pool] proof_validity_blocks:",
  proofValidityBlocks,
);
console.log("[deploy-privacy-pool] salt:", salt);

const classHash = await declarePoolClass(adminAccount);
console.log("[deploy-privacy-pool] class hash:", classHash);

const deployResponse = await adminAccount.deployContract(
  {
    classHash,
    constructorCalldata: [admin.address, auditorPublicKey, proofValidityBlocks],
    salt,
  },
  { retryInterval: 200 },
);
const poolAddress = deployResponse.contract_address;
console.log("[deploy-privacy-pool] pool deployed at:", poolAddress);

// Sanity check: read back proof_validity_blocks via the contract's view.
const contract = new Contract({
  abi: PrivacyPoolABI,
  address: poolAddress,
  providerOrAccount: provider,
}).typedv2(PrivacyPoolABI);
const readBack = await contract.get_proof_validity_blocks();
console.log(
  "[deploy-privacy-pool] on-chain proof_validity_blocks:",
  readBack.toString(),
);

console.log("");
console.log("Update demo/.env.testnet.local:");
console.log(`  VITE_POOL_CLASS_HASH=${classHash}`);
console.log(`  VITE_POOL_ADDRESS=${poolAddress}`);
