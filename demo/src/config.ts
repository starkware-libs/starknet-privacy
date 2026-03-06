import type { constants } from "starknet";

export type AccountConfig = {
  name: string;
  address: string;
  privateKey: string;
  viewingKey: string;
};

export type TokenConfig = {
  name: string;
  address: string;
  decimals: number;
};

export type EkuboConfig = {
  coreAddress: string;
  executorAddress: string;
  poolFee: string;
  tickSpacing: string;
  extension: string;
  skipAhead: string;
  swapTokens: TokenConfig[];
};

export type AppConfig = {
  rpcUrl: string;
  indexerUrl: string;
  poolAddress: string;
  poolClassHash: string;
  compliancePublicKey: string;
  proofValidityBlocks: string;
  tokens: TokenConfig[];
  feeTokenAddress: string;
  chainId: constants.StarknetChainId;
  adminAddress: string;
  adminKey: string;
  accounts: AccountConfig[];
  /** Proving service URL. If set, uses real prover; otherwise mock. */
  provingServiceUrl?: string;
  gatewayUrl?: string;
  feederGatewayUrl?: string;
  ekubo?: EkuboConfig;
};

function requireEnv(key: string): string {
  const value = import.meta.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value as string;
}

function parseEkuboConfig(): EkuboConfig | undefined {
  const executorAddress = import.meta.env.VITE_EXECUTOR_ADDRESS as string | undefined;
  if (!executorAddress) return undefined;
  const swapTokensRaw = requireEnv("VITE_EKUBO_SWAP_TOKENS");
  let swapTokens: TokenConfig[];
  try {
    swapTokens = JSON.parse(swapTokensRaw) as TokenConfig[];
  } catch {
    throw new Error("VITE_EKUBO_SWAP_TOKENS must be valid JSON array");
  }

  return {
    coreAddress: requireEnv("VITE_EKUBO_CORE_ADDRESS"),
    executorAddress,
    poolFee: requireEnv("VITE_EKUBO_POOL_FEE"),
    tickSpacing: requireEnv("VITE_EKUBO_TICK_SPACING"),
    extension: requireEnv("VITE_EKUBO_EXTENSION"),
    skipAhead: requireEnv("VITE_EKUBO_SKIP_AHEAD"),
    swapTokens,
  };
}

export function loadConfig(): AppConfig {
  const accountsRaw = requireEnv("VITE_ACCOUNTS");
  let accounts: AccountConfig[];
  try {
    accounts = JSON.parse(accountsRaw) as AccountConfig[];
  } catch {
    throw new Error("VITE_ACCOUNTS must be valid JSON array");
  }

  const tokensRaw = requireEnv("VITE_TOKENS");
  let tokens: TokenConfig[];
  try {
    tokens = JSON.parse(tokensRaw) as TokenConfig[];
  } catch {
    throw new Error("VITE_TOKENS must be valid JSON array");
  }

  return {
    rpcUrl: requireEnv("VITE_RPC_URL"),
    indexerUrl: requireEnv("VITE_INDEXER_URL"),
    poolAddress: requireEnv("VITE_POOL_ADDRESS"),
    poolClassHash: requireEnv("VITE_POOL_CLASS_HASH"),
    compliancePublicKey: requireEnv("VITE_COMPLIANCE_PUBLIC_KEY"),
    proofValidityBlocks: (import.meta.env.VITE_PROOF_VALIDITY_BLOCKS as string) || "450",
    tokens,
    feeTokenAddress: requireEnv("VITE_FEE_TOKEN_ADDRESS"),
    chainId: requireEnv("VITE_CHAIN_ID") as constants.StarknetChainId,
    adminAddress: requireEnv("VITE_ADMIN_ADDRESS"),
    adminKey: requireEnv("VITE_ADMIN_KEY"),
    accounts,
    provingServiceUrl: import.meta.env.VITE_PROVING_SERVICE_URL as string | undefined,
    gatewayUrl: import.meta.env.VITE_GATEWAY_URL as string | undefined,
    feederGatewayUrl: import.meta.env.VITE_FEEDER_GATEWAY_URL as string | undefined,
    ekubo: parseEkuboConfig(),
  };
}
