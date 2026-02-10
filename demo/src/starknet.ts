import { Account, RpcProvider, type constants } from "starknet";
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

export function createAccount(
  provider: RpcProvider,
  address: string,
  privateKey: string,
): Account {
  return new Account({ provider, address, signer: privateKey, cairoVersion: "1" });
}

export function createTransfers(
  provider: RpcProvider,
  account: Account,
  accountConfig: AccountConfig,
  config: AppConfig,
): PrivateTransfersInterface {
  const discovery = new IndexerDiscoveryProvider(config.indexerUrl, config.poolAddress);
  const provingProvider = config.provingServiceUrl
    ? new ProvingServiceProofProvider(
        config.provingServiceUrl,
        provider,
        config.chainId,
      )
    : new NoValidateProofProvider(provider, config.chainId);
  return createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => BigInt(accountConfig.viewingKey) },
    provingProvider,
    discoveryProvider: discovery,
    poolContractAddress: config.poolAddress,
  });
}

export async function getErc20Balance(
  provider: RpcProvider,
  tokenAddress: string,
  ownerAddress: string,
): Promise<bigint> {
  const result = await provider.callContract({
    contractAddress: tokenAddress,
    entrypoint: "balance_of",
    calldata: [ownerAddress],
  });
  return BigInt(result[0]);
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
  l2_gas: { max_amount: 2_000_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 5_000n, max_price_per_unit: L1_DATA_GAS_PRICE },
};
