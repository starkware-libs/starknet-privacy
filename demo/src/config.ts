import type { constants } from "starknet";

export type AccountConfig = {
  name: string;
  address: string;
  privateKey: string;
  viewingKey: string;
  admin?: boolean;
};

export type TokenConfig = {
  name: string;
  address: string;
  decimals: number;
  fee?: boolean;
  /** Entrypoint name for minting. Defaults to "permissionedMint". */
  mintEntrypoint?: string;
};

export type EkuboConfig = {
  coreAddress: string;
  routerAddress: string;
  executorAddress: string;
  poolToken0: string;
  poolToken1: string;
  poolFee: string;
  tickSpacing: string;
  extension: string;
  skipAhead: string;
  swapTokens: TokenConfig[];
};

export type VesuVault = {
  tokenConfig: TokenConfig;
  vTokenAddress: string;
};

export type VesuConfig = {
  helperAddress: string;
  vaults: VesuVault[];
};

export type AppConfig = {
  rpcUrl: string;
  indexerUrl: string;
  poolAddress: string;
  poolClassHash: string;
  compliancePublicKey: string;
  proofValidityBlocks: string;
  tokens: TokenConfig[];
  chainId: constants.StarknetChainId;
  /** Proving service URL. If set, uses real prover; otherwise mock. */
  provingServiceUrl?: string;
  /** Real backend indexer URL. When set, OHTTP uses this as gateway and indexerUrl as relay. */
  backendIndexerUrl?: string;
  /** Real backend prover URL. When set, OHTTP uses this as gateway and provingServiceUrl as relay. */
  backendProverUrl?: string;
  /** Pinned OHTTP key config (decoded from base64). Avoids fetching /ohttp-keys at runtime. */
  ohttpKeyConfig?: Uint8Array;
  gatewayUrl?: string;
  feederGatewayUrl?: string;
  explorerUrl?: string;
  ekubo?: EkuboConfig;
  vesu?: VesuConfig;
};

function requireEnv(key: string): string {
  const value = import.meta.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value as string;
}

function parseEkuboConfig(tokens: TokenConfig[]): EkuboConfig | undefined {
  const executorAddress = import.meta.env.VITE_EKUBO_EXECUTOR_ADDRESS as string | undefined;
  if (!executorAddress) return undefined;

  const poolRaw = requireEnv("VITE_EKUBO_POOL");
  let pool: {
    token0: string;
    token1: string;
    fee: string;
    tickSpacing: string;
    extension: string;
    skipAhead: string;
  };
  try {
    pool = JSON.parse(poolRaw);
  } catch {
    throw new Error("VITE_EKUBO_POOL must be valid JSON");
  }

  const tokenByAddress = new Map(tokens.map((t) => [t.address, t]));
  const swapTokens = [pool.token0, pool.token1]
    .map((address) => tokenByAddress.get(address))
    .filter((t): t is TokenConfig => t != null);

  return {
    coreAddress: requireEnv("VITE_EKUBO_CORE_ADDRESS"),
    routerAddress: requireEnv("VITE_EKUBO_ROUTER_ADDRESS"),
    executorAddress,
    poolToken0: pool.token0,
    poolToken1: pool.token1,
    poolFee: pool.fee,
    tickSpacing: pool.tickSpacing,
    extension: pool.extension,
    skipAhead: pool.skipAhead,
    swapTokens,
  };
}

function parseVesuConfig(tokens: TokenConfig[]): VesuConfig | undefined {
  const helperAddress = import.meta.env.VITE_VESU_LENDING_HELPER_ADDRESS as string | undefined;
  if (!helperAddress) return undefined;

  const raw = requireEnv("VITE_VESU");
  let parsed: { vaults: { token: string; vTokenAddress: string }[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("VITE_VESU must be valid JSON");
  }

  const tokenByName = new Map(tokens.map((t) => [t.name, t]));
  const vaults = parsed.vaults.map((vault) => {
    const tokenConfig = tokenByName.get(vault.token);
    if (!tokenConfig) throw new Error(`VITE_VESU vaults: unknown token "${vault.token}"`);
    return { tokenConfig, vTokenAddress: vault.vTokenAddress };
  });

  return { helperAddress, vaults };
}

export function loadConfig(): AppConfig {
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
    chainId: requireEnv("VITE_CHAIN_ID") as constants.StarknetChainId,
    provingServiceUrl: import.meta.env.VITE_PROVING_SERVICE_URL as string | undefined,
    backendIndexerUrl: import.meta.env.VITE_BACKEND_INDEXER_URL as string | undefined,
    backendProverUrl: import.meta.env.VITE_BACKEND_PROVER_URL as string | undefined,
    ohttpKeyConfig: import.meta.env.VITE_OHTTP_KEY_CONFIG
      ? Uint8Array.from(atob(import.meta.env.VITE_OHTTP_KEY_CONFIG as string), (c) => c.charCodeAt(0))
      : undefined,
    gatewayUrl: import.meta.env.VITE_GATEWAY_URL as string | undefined,
    feederGatewayUrl: import.meta.env.VITE_FEEDER_GATEWAY_URL as string | undefined,
    explorerUrl: import.meta.env.VITE_EXPLORER_URL as string | undefined,
    ekubo: parseEkuboConfig(tokens),
    vesu: parseVesuConfig(tokens),
  };
}
