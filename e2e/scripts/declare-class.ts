/**
 * Declare the privacy pool contract class on a live network (e.g. Sepolia).
 *
 * Reads env vars:
 *   VITE_RPC_URL        — JSON-RPC endpoint
 *   ACCOUNTS       — JSON array of accounts (admin has "admin": true)
 *
 * Usage: npm run declare-class   (from e2e/, with .env populated)
 */

import { Account, RpcProvider } from "starknet";
import { declarePoolClass } from "../src/harness.js";

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

const classHash = await declarePoolClass(adminAccount);
console.log("Update VITE_POOL_CLASS_HASH in .env to:", classHash);
