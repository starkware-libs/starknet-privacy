import { Account, RpcProvider } from "starknet";
import {
  createPrivateTransfers,
  ProvingServiceProofProvider,
  type PrivateTransfersInterface,
} from "starknet-sdk";
// Direct import avoids pulling in Node-only modules from the testing barrel
// @ts-expect-error — deep import into dist, not part of the declared exports
import { IndexerDiscoveryProvider } from "starknet-sdk/dist/internal/indexer-discovery.js";
import type { AppConfig, AccountConfig } from "./config.ts";
import { NoValidateProofProvider } from "./proof-provider.ts";

export function createProvider(rpcUrl: string): RpcProvider {
  return new RpcProvider({ nodeUrl: rpcUrl });
}

export function createAccount(provider: RpcProvider, address: string, privateKey: string): Account {
  return new Account({ provider, address, signer: privateKey, cairoVersion: "1" });
}

export function createTransfers(
  provider: RpcProvider,
  account: Account,
  accountConfig: AccountConfig,
  poolAddress: string,
  config: AppConfig
): PrivateTransfersInterface {
  const discovery = new IndexerDiscoveryProvider(config.indexerUrl, poolAddress);
  const provingProvider = config.provingServiceUrl
    ? new ProvingServiceProofProvider(config.provingServiceUrl, config.chainId)
    : new NoValidateProofProvider(provider, config.chainId);
  return createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => BigInt(accountConfig.viewingKey) },
    provingProvider,
    discoveryProvider: discovery,
    poolContractAddress: poolAddress,
  });
}

export async function getErc20Balance(
  provider: RpcProvider,
  tokenAddress: string,
  ownerAddress: string
): Promise<bigint> {
  const result = await provider.callContract({
    contractAddress: tokenAddress,
    entrypoint: "balance_of",
    calldata: [ownerAddress],
  });
  return BigInt(result[0]);
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
  // sqrt_ratio is a u256 (low, high) in the first two felt values
  const low = BigInt(result[0]);
  const high = BigInt(result[1]);
  const sqrtRatio = low + (high << 128n);

  // price = (sqrtRatio / 2^128)^2, adjusted for decimal difference
  const ratio = Number(sqrtRatio) / 2 ** 128;
  const price = ratio * ratio * 10 ** (token0Decimals - token1Decimals);

  return { sqrtRatio, price };
}

// Resource bounds for integration sepolia (2x headroom over actual prices)
const L2_GAS_PRICE = 16_000_000_000n;
const L1_GAS_PRICE = 1_000_000_000_000n;
const L1_DATA_GAS_PRICE = 2_000n;

export const ERC20_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 2_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 640n, max_price_per_unit: L1_DATA_GAS_PRICE },
};

export const POOL_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 100_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 5_000n, max_price_per_unit: L1_DATA_GAS_PRICE },
};

export const DEPLOY_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 4_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 3_500n, max_price_per_unit: L1_DATA_GAS_PRICE },
};
