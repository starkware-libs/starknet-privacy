import type { constants, RpcProvider } from "starknet";
import { paymasterBuildApplyAction } from "./paymaster.ts";

// `viewingKey` is optional: if a `privateKey` is supplied the demo derives
// the viewing key deterministically (see `deriveViewingKey` in session.ts).
// A view-only account supplies `viewingKey` but no `privateKey`. At least
// one of the two must be present.
export type AccountConfig = {
  name: string;
  address: string;
  privateKey?: string;
  viewingKey?: string;
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

export type EkuboPool = {
  token0: string;
  token1: string;
  fee: string;
  tickSpacing: string;
  extension: string;
  skipAhead: string;
};

export type EkuboConfig = {
  coreAddress: string;
  routerAddress: string;
  executorAddress: string;
  pools: EkuboPool[];
  /** Union of all token addresses across pools, resolved to TokenConfig. */
  swapTokens: TokenConfig[];
};

// The Ekubo swap anonymizer is single-hop: it takes one pool_key per swap. To
// support multiple pairs, the app carries an array of pool configs and
// picks the matching one at swap time. Token order in a pool is canonical
// (numerically ascending), so a pool serves both directions.
export function findEkuboPool(
  ekubo: EkuboConfig | undefined,
  fromToken: string,
  toToken: string
): EkuboPool | undefined {
  if (!ekubo || !fromToken || !toToken) return undefined;
  const fromBig = BigInt(fromToken);
  const toBig = BigInt(toToken);
  return ekubo.pools.find((pool) => {
    const t0 = BigInt(pool.token0);
    const t1 = BigInt(pool.token1);
    return (t0 === fromBig && t1 === toBig) || (t0 === toBig && t1 === fromBig);
  });
}

export type VesuVault = {
  tokenConfig: TokenConfig;
  vTokenAddress: string;
};

export type VesuConfig = {
  anonymizerAddress: string;
  vaults: VesuVault[];
};

export type ForgeStrategy = {
  tokenConfig: TokenConfig;
  /** Address of the ForgeYields TokenGateway (or MockForgeYieldsGateway on devnet). */
  gateway: string;
  /** Share token ticker, e.g. fyUSDC. */
  symbol: string;
};

export type ForgeConfig = {
  anonymizerAddress: string;
  strategies: ForgeStrategy[];
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
  forge?: ForgeConfig;
  /** Whether OHTTP encryption is enabled for indexer and prover requests. Default true. */
  ohttpEnabled?: boolean;
  paymasterUrl?: string;
  paymasterFeeToken?: string;
  avnuApiKey?: string;
  paymasterForwarderAddress?: string;
  /**
   * Protocol fee charged on every `apply_actions` call, in STRK wei. Cached
   * from the pool's `get_fee_amount()` view. When the paymaster is disabled
   * the user's account must approve this amount of STRK to the pool on top
   * of any token-specific allowances.
   */
  feeAmount?: bigint;
  /** Fee recipient (pool's `get_fee_collector()` view). Cached for display. */
  feeCollectorAddress?: string;
};

function requireEnv(key: string): string {
  const value = import.meta.env[key];
  if (!value) throw new Error(`Missing env var: ${key}`);
  return value as string;
}

function parseEkuboConfig(tokens: TokenConfig[]): EkuboConfig | undefined {
  const executorAddress = import.meta.env.VITE_EKUBO_EXECUTOR_ADDRESS as string | undefined;
  if (!executorAddress) return undefined;

  const poolsRaw = requireEnv("VITE_EKUBO_POOLS");
  let pools: EkuboPool[];
  try {
    const parsed = JSON.parse(poolsRaw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not array");
    pools = parsed as EkuboPool[];
  } catch {
    throw new Error("VITE_EKUBO_POOLS must be a JSON array of pool configs");
  }

  // Union of pool tokens resolved against VITE_TOKENS. Addresses not in
  // VITE_TOKENS are dropped (e.g. a pool references a token the demo
  // doesn't know about).
  const tokenByBigInt = new Map(tokens.map((t) => [BigInt(t.address), t]));
  const addressesInPools = new Set<bigint>();
  for (const pool of pools) {
    addressesInPools.add(BigInt(pool.token0));
    addressesInPools.add(BigInt(pool.token1));
  }
  const swapTokens = [...addressesInPools]
    .map((addr) => tokenByBigInt.get(addr))
    .filter((t): t is TokenConfig => t != null);

  return {
    coreAddress: requireEnv("VITE_EKUBO_CORE_ADDRESS"),
    routerAddress: requireEnv("VITE_EKUBO_ROUTER_ADDRESS"),
    executorAddress,
    pools,
    swapTokens,
  };
}

function parseVesuConfig(tokens: TokenConfig[]): VesuConfig | undefined {
  // TODO: rename env key to VITE_VESU_LENDING_ANONYMIZER_ADDRESS once the
  // Vercel project (keep-starknet-strange/starknet-privacy-demo) env vars
  // are updated to the new key. Kept as HELPER here so the existing preview
  // deployment continues to surface the Vesu UI.
  const anonymizerAddress = import.meta.env.VITE_VESU_LENDING_HELPER_ADDRESS as string | undefined;
  if (!anonymizerAddress) return undefined;

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

  return { anonymizerAddress, vaults };
}

function parseForgeConfig(tokens: TokenConfig[]): ForgeConfig | undefined {
  const anonymizerAddress = import.meta.env.VITE_FORGE_ANONYMIZER_ADDRESS as string | undefined;
  if (!anonymizerAddress) return undefined;

  const raw = requireEnv("VITE_FORGE");
  let parsed: { strategies: { token: string; gateway: string; symbol: string }[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("VITE_FORGE must be valid JSON");
  }

  const tokenByName = new Map(tokens.map((t) => [t.name, t]));
  const strategies = parsed.strategies.map((s) => {
    const tokenConfig = tokenByName.get(s.token);
    if (!tokenConfig) throw new Error(`VITE_FORGE strategies: unknown token "${s.token}"`);
    return { tokenConfig, gateway: s.gateway, symbol: s.symbol };
  });

  return { anonymizerAddress, strategies };
}

export function loadConfig(): AppConfig {
  const tokensRaw = requireEnv("VITE_TOKENS");
  let tokens: TokenConfig[];
  try {
    tokens = JSON.parse(tokensRaw) as TokenConfig[];
  } catch {
    throw new Error("VITE_TOKENS must be valid JSON array");
  }

  const ekubo = parseEkuboConfig(tokens);
  const vesu = parseVesuConfig(tokens);
  const forge = parseForgeConfig(tokens);

  // Append Vesu vTokens to the displayed token list so their balances
  // render alongside the underlying assets. Vesu vTokens are always 18
  // decimals regardless of the underlying (verified on-chain via
  // `scripts/query-vtoken-decimals.ts`) — do NOT inherit `tokenConfig.decimals`.
  // Ekubo's swapTokens was already captured above, so vTokens won't appear
  // as swap options.
  if (vesu) {
    const known = new Set(tokens.map((t) => BigInt(t.address)));
    for (const vault of vesu.vaults) {
      const vTokenAddrBigInt = BigInt(vault.vTokenAddress);
      if (known.has(vTokenAddrBigInt)) continue;
      tokens.push({
        name: `v${vault.tokenConfig.name}`,
        address: vault.vTokenAddress,
        decimals: 18,
      });
      known.add(vTokenAddrBigInt);
    }
  }

  // Forge gateways are ERC-20 share tokens (gateway == share token). Surface
  // their balance alongside the underlying so users see their position.
  // Shares are always 18 decimals regardless of underlying.
  if (forge) {
    const known = new Set(tokens.map((t) => BigInt(t.address)));
    for (const strat of forge.strategies) {
      const addrBigInt = BigInt(strat.gateway);
      if (known.has(addrBigInt)) continue;
      tokens.push({
        name: strat.symbol,
        address: strat.gateway,
        decimals: 18,
      });
      known.add(addrBigInt);
    }
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
      ? Uint8Array.from(atob(import.meta.env.VITE_OHTTP_KEY_CONFIG as string), (c) =>
          c.charCodeAt(0)
        )
      : undefined,
    gatewayUrl: import.meta.env.VITE_GATEWAY_URL as string | undefined,
    feederGatewayUrl: import.meta.env.VITE_FEEDER_GATEWAY_URL as string | undefined,
    explorerUrl: import.meta.env.VITE_EXPLORER_URL as string | undefined,
    ekubo,
    vesu,
    forge,
    paymasterUrl: import.meta.env.VITE_PAYMASTER_URL as string | undefined,
    paymasterFeeToken: import.meta.env.VITE_PAYMASTER_FEE_TOKEN as string | undefined,
    avnuApiKey: import.meta.env.VITE_AVNU_API_KEY as string | undefined,
    paymasterForwarderAddress: import.meta.env.VITE_PAYMASTER_FORWARDER_ADDRESS as
      | string
      | undefined,
  };
}

/**
 * Fetch the pool's protocol fee (amount + collector) once and cache it on
 * the config. The pool's `apply_actions` calls `collect_fee()` which pulls
 * `fee_amount` STRK from the tx caller to `fee_collector`. When the
 * paymaster is disabled the user account is the caller, so the demo must
 * approve STRK to the pool for this amount on top of any per-token allowance.
 */
export async function initFeeConfig(config: AppConfig, provider: RpcProvider): Promise<void> {
  if (config.feeAmount !== undefined) return;
  try {
    const [amountResult, collectorResult] = await Promise.all([
      provider.callContract({
        contractAddress: config.poolAddress,
        entrypoint: "get_fee_amount",
        calldata: [],
      }),
      provider.callContract({
        contractAddress: config.poolAddress,
        entrypoint: "get_fee_collector",
        calldata: [],
      }),
    ]);
    config.feeAmount = BigInt(amountResult[0]);
    config.feeCollectorAddress = collectorResult[0];
  } catch (err) {
    console.warn("Failed to fetch pool fee config:", err);
  }
}

/** Fetch the paymaster forwarder address once and store it in the config. */
export async function initPaymasterForwarder(config: AppConfig): Promise<void> {
  if (!config.paymasterUrl || !config.paymasterFeeToken || config.paymasterForwarderAddress) return;
  try {
    const { fee_action } = await paymasterBuildApplyAction(
      config.paymasterUrl,
      config.poolAddress,
      { mode: "sponsored_private", pool_fee_token: config.paymasterFeeToken, tip: "normal" },
      config.avnuApiKey
    );
    config.paymasterForwarderAddress = fee_action.recipient;
  } catch (err) {
    console.warn("Failed to fetch paymaster forwarder address:", err);
  }
}
