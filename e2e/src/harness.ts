import { constants } from "starknet";
import {
  Devnet,
  type DevnetEnvironment,
  CallMockProofProvider,
  ContractDiscoveryProvider,
} from "starknet-sdk/testing";
import { createPrivateTransfers, type PrivateTransfersInterface } from "starknet-sdk";
import { IndexerClient, type IndexerSpawnConfig } from "./indexer-client.js";

export interface E2eTestEnv {
  devnet: Devnet;
  env: DevnetEnvironment;
  transfers: {
    alice: PrivateTransfersInterface;
    bob: PrivateTransfersInterface;
  };
  indexer: IndexerClient;
}

export interface E2eTestEnvConfig {
  indexer?: Partial<IndexerSpawnConfig>;
}

// TODO: Replace ContractDiscoveryProvider with IndexerDiscoveryProvider once implemented,
// so e2e tests exercise the real wallet flow through the indexer.
export async function createE2eTestEnv(
  devnet: Devnet,
  config?: E2eTestEnvConfig
): Promise<E2eTestEnv> {
  const env = await devnet.initialize();
  const chainId = constants.StarknetChainId.SN_SEPOLIA;

  const indexer = await IndexerClient.spawn({
    wsUrl: devnet.wsUrl,
    rpcUrl: devnet.url,
    contractAddress: env.privacy.address,
    ...config?.indexer,
  });
  await indexer.waitUntilReady(devnet.url);

  const transfers = {
    alice: createPrivateTransfers({
      account: env.alice,
      viewingKeyProvider: { getViewingKey: () => BigInt("0xA11CE") },
      provingProvider: new CallMockProofProvider(env.provider, chainId),
      discoveryProvider: new ContractDiscoveryProvider(env.privacy),
      poolContractAddress: env.privacy.address,
    }),
    bob: createPrivateTransfers({
      account: env.bob,
      viewingKeyProvider: { getViewingKey: () => BigInt("0xB0B") },
      provingProvider: new CallMockProofProvider(env.provider, chainId),
      discoveryProvider: new ContractDiscoveryProvider(env.privacy),
      poolContractAddress: env.privacy.address,
    }),
  };

  return { devnet, env, transfers, indexer };
}
