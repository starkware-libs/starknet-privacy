import type { constants } from "starknet";

export type AccountConfig = {
  name: string;
  address: string;
  privateKey: string;
  viewingKey: string;
};

export type AppConfig = {
  rpcUrl: string;
  indexerUrl: string;
  poolAddress: string;
  tokenAddress: string;
  feeTokenAddress: string;
  chainId: constants.StarknetChainId;
  adminAddress: string;
  adminKey: string;
  accounts: AccountConfig[];
};

function requireEnv(key: string): string {
  const value = import.meta.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value as string;
}

export function loadConfig(): AppConfig {
  const accountsRaw = requireEnv("VITE_ACCOUNTS");
  let accounts: AccountConfig[];
  try {
    accounts = JSON.parse(accountsRaw) as AccountConfig[];
  } catch {
    throw new Error("VITE_ACCOUNTS must be valid JSON array");
  }

  return {
    rpcUrl: requireEnv("VITE_RPC_URL"),
    indexerUrl: requireEnv("VITE_INDEXER_URL"),
    poolAddress: requireEnv("VITE_POOL_ADDRESS"),
    tokenAddress: requireEnv("VITE_TOKEN_ADDRESS"),
    feeTokenAddress: requireEnv("VITE_FEE_TOKEN_ADDRESS"),
    chainId: requireEnv("VITE_CHAIN_ID") as constants.StarknetChainId,
    adminAddress: requireEnv("VITE_ADMIN_ADDRESS"),
    adminKey: requireEnv("VITE_ADMIN_KEY"),
    accounts,
  };
}
