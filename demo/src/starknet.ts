import {
  Account,
  BlockTag,
  RpcProvider,
  TransactionFinalityStatus,
  type waitForTransactionOptions,
} from "starknet";
import {
  createPrivateTransfers,
  ProvingServiceProofProvider,
  type PrivateTransfersInterface,
} from "starknet-sdk";
// Direct import avoids pulling in Node-only modules from the testing barrel
// @ts-expect-error — deep import into dist, not part of the declared exports
import { IndexerDiscoveryProvider } from "starknet-sdk/dist/internal/indexer-discovery.js";
import type { AppConfig } from "./config.ts";
import { NoValidateProofProvider } from "./proof-provider.ts";

/**
 * STRK fee-token address. Hardcoded into the privacy pool Cairo
 * (`packages/privacy/src/utils.cairo:62`) and identical across mainnet,
 * sepolia, and devnet — safe to pin as a module constant.
 */
export const STRK_TOKEN_ADDRESS =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

/** Must include the ACCEPTED_ON_L* states, else a tx skipping PRE_CONFIRMED is polled forever. */
export const WAIT_OPTIONS: waitForTransactionOptions = {
  successStates: [
    TransactionFinalityStatus.PRE_CONFIRMED,
    TransactionFinalityStatus.ACCEPTED_ON_L2,
    TransactionFinalityStatus.ACCEPTED_ON_L1,
  ],
  retryInterval: 100,
};

export function createDiscoveryProvider(
  config: AppConfig,
  poolAddress: string
): InstanceType<typeof IndexerDiscoveryProvider> {
  if (config.ohttpEnabled === false) {
    return new IndexerDiscoveryProvider(config.indexerUrl, poolAddress);
  }
  if (config.backendIndexerUrl) {
    return new IndexerDiscoveryProvider(config.backendIndexerUrl, poolAddress, {
      ohttp: { relayUrl: config.indexerUrl, publicKeyConfig: config.ohttpKeyConfig },
    });
  }
  return new IndexerDiscoveryProvider(config.indexerUrl, poolAddress, {
    ohttp: config.ohttpKeyConfig ? { publicKeyConfig: config.ohttpKeyConfig } : true,
  });
}

export function createProvider(rpcUrl: string): RpcProvider {
  // Nonce reads and fee estimates must use the block tag the flow waits for
  // (WAIT_OPTIONS → PRE_CONFIRMED); the default `latest` omits pre-confirmed
  // txs, so a dependent follow-up tx would build on a stale nonce.
  return new RpcProvider({ nodeUrl: rpcUrl, batch: 50, blockIdentifier: BlockTag.PRE_CONFIRMED });
}

export function createAccount(provider: RpcProvider, address: string, privateKey: string): Account {
  return new Account({
    provider,
    address,
    signer: privateKey,
    cairoVersion: "1",
  });
}

export function createTransfers(
  provider: RpcProvider,
  account: Account,
  viewingKey: bigint,
  poolAddress: string,
  config: AppConfig
): PrivateTransfersInterface {
  const discovery = createDiscoveryProvider(config, poolAddress);
  const ohttpOption = config.ohttpEnabled !== false ? { ohttp: true } : {};
  const provingProvider = config.provingServiceUrl
    ? new ProvingServiceProofProvider(config.provingServiceUrl, config.chainId, ohttpOption)
    : new NoValidateProofProvider(provider, config.chainId);
  return createPrivateTransfers({
    account,
    viewingKeyProvider: {
      getViewingKey: async () => viewingKey,
    },
    provingProvider,
    discoveryProvider: discovery,
    poolContractAddress: poolAddress,
  });
}

export async function getErc20Balance(
  provider: RpcProvider,
  tokenAddress: string,
  ownerAddress: string,
  blockIdentifier?: string
): Promise<bigint> {
  const result = await provider.callContract(
    {
      contractAddress: tokenAddress,
      entrypoint: "balance_of",
      calldata: [ownerAddress],
    },
    blockIdentifier
  );
  return BigInt(result[0]);
}

/** ERC-4626 preview_deposit: given assets, returns estimated shares minted. */
export async function previewDeposit(
  provider: RpcProvider,
  vTokenAddress: string,
  assets: bigint
): Promise<bigint> {
  const result = await provider.callContract({
    contractAddress: vTokenAddress,
    entrypoint: "preview_deposit",
    calldata: [assets.toString(), "0"],
  });
  return BigInt(result[0]);
}

/** ERC-4626 preview_redeem: given shares, returns estimated underlying assets. */
export async function previewRedeem(
  provider: RpcProvider,
  vTokenAddress: string,
  shares: bigint
): Promise<bigint> {
  const result = await provider.callContract({
    contractAddress: vTokenAddress,
    entrypoint: "preview_redeem",
    calldata: [shares.toString(), "0"],
  });
  return BigInt(result[0]);
}

export type TokenMetadata = {
  name: string;
  symbol: string;
  decimals: number;
};

function decodeFeltString(hex: string): string {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  let result = "";
  for (let offset = 0; offset < raw.length; offset += 2) {
    const code = parseInt(raw.slice(offset, offset + 2), 16);
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result;
}

export async function getErc20Metadata(
  provider: RpcProvider,
  tokenAddress: string
): Promise<TokenMetadata> {
  const [nameResult, symbolResult, decimalsResult] = await Promise.all([
    provider.callContract({ contractAddress: tokenAddress, entrypoint: "name", calldata: [] }),
    provider.callContract({ contractAddress: tokenAddress, entrypoint: "symbol", calldata: [] }),
    provider.callContract({ contractAddress: tokenAddress, entrypoint: "decimals", calldata: [] }),
  ]);
  return {
    name: decodeFeltString(nameResult[0]),
    symbol: decodeFeltString(symbolResult[0]),
    decimals: Number(decimalsResult[0]),
  };
}

export type PoolPriceResult = {
  sqrtRatio: bigint;
  price: number;
};

/**
 * Fetch the current pool price from the Ekubo Core contract.
 *
 * Calls `get_pool_price` with the pool key and converts the returned
 * sqrt_ratio (64.128 fixed-point) to a human-readable price:
 *   price = (sqrt_ratio / 2^128)^2 * 10^(token0_decimals - token1_decimals)
 */
export async function getPoolPrice(
  provider: RpcProvider,
  coreAddress: string,
  token0: string,
  token1: string,
  fee: string,
  tickSpacing: string,
  extension: string,
  token0Decimals: number,
  token1Decimals: number
): Promise<PoolPriceResult> {
  const result = await provider.callContract({
    contractAddress: coreAddress,
    entrypoint: "get_pool_price",
    calldata: [token0, token1, fee, tickSpacing, extension],
  });
  const low = BigInt(result[0]);
  const high = BigInt(result[1]);
  const sqrtRatio = low + (high << 128n);

  const ratio = Number(sqrtRatio) / 2 ** 128;
  const price = ratio * ratio * 10 ** (token0Decimals - token1Decimals);

  return { sqrtRatio, price };
}
