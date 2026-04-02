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
  return new RpcProvider({ nodeUrl: rpcUrl, batch: 50 });
}

export function createAccount(
  provider: RpcProvider,
  address: string,
  privateKey: string,
): Account {
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
  accountConfig: AccountConfig,
  poolAddress: string,
  config: AppConfig
): PrivateTransfersInterface {
  const discovery = new IndexerDiscoveryProvider(
    config.indexerUrl,
    poolAddress,
  );
  const provingProvider = config.provingServiceUrl
    ? new ProvingServiceProofProvider(config.provingServiceUrl, config.chainId)
    : new NoValidateProofProvider(provider, config.chainId);
  return createPrivateTransfers({
    account,
    viewingKeyProvider: {
      getViewingKey: async () => BigInt(accountConfig.viewingKey),
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
  blockIdentifier?: string,
): Promise<bigint> {
  const result = await provider.callContract(
    {
      contractAddress: tokenAddress,
      entrypoint: "balance_of",
      calldata: [ownerAddress],
    },
    blockIdentifier,
  );
  return BigInt(result[0]);
}

/** ERC-4626 preview_deposit: given assets, returns estimated shares minted. */
export async function previewDeposit(
  provider: RpcProvider,
  vTokenAddress: string,
  assets: bigint,
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
  shares: bigint,
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
  tokenAddress: string,
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
  token1Decimals: number,
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
