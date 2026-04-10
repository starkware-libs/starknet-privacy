/**
 * Factory functions for creating SDK instances.
 */

import type {
  PrivateTransfersInterface,
  ViewingKeyProvider,
  ProofProviderInterface,
  ProofProviderConfig,
  DiscoveryProviderInterface,
  DiscoveryProviderConfig,
  StarknetAddress,
} from "./interfaces.js";
import type { Account } from "starknet";
import { PrivateTransfers } from "./internal/private-transfers.js";
import {
  ProofInvocationFactory,
  type ProofInvocationFactoryInterface,
} from "./internal/proof-invocation-factory.js";
import { ProvingServiceProofProvider } from "./internal/proving-service-provider.js";
import { IndexerDiscoveryProvider } from "./internal/indexer-discovery.js";

function isProofProviderConfig(
  x: ProofProviderInterface | ProofProviderConfig
): x is ProofProviderConfig {
  return typeof x === "object" && x !== null && "url" in x && "chainId" in x;
}

function isDiscoveryProviderConfig(
  x: DiscoveryProviderInterface | DiscoveryProviderConfig
): x is DiscoveryProviderConfig {
  return typeof x === "object" && x !== null && "url" in x && !("discoverNotes" in x);
}

/**
 * Creates a new PrivateTransfers instance for interacting with the privacy pool.
 *
 * You can pass either **instances** (e.g. mocks or your own implementations) or **configs**
 * for the production proving and discovery providers. When you pass a config, the factory
 * creates the corresponding production implementation (ProvingServiceProofProvider /
 * IndexerDiscoveryProvider) for you.
 *
 * @param params - Configuration object containing account, providers (or configs), and pool address
 * @returns A PrivateTransfers instance
 *
 * @example With instances (e.g. mocks)
 * ```typescript
 * const privateTransfers = createPrivateTransfers({
 *   account: myAccount,
 *   viewingKeyProvider: { getViewingKey: async () => myPrivateKey },
 *   provingProvider: new MockProofProvider(pool),
 *   discoveryProvider: new ContractDiscoveryProvider(pool),
 *   poolContractAddress: poolAddress,
 * });
 * ```
 *
 * @example With production configs
 * ```typescript
 * const privateTransfers = createPrivateTransfers({
 *   account: myAccount,
 *   viewingKeyProvider: { getViewingKey: async () => myPrivateKey },
 *   provingProvider: { url: "https://prover.example.com", chainId: constants.StarknetChainId.SN_MAIN },
 *   discoveryProvider: { url: "https://indexer.example.com" },
 *   poolContractAddress: poolAddress,
 * });
 * ```
 */
export function createPrivateTransfers(params: {
  account: Account;
  viewingKeyProvider: ViewingKeyProvider;
  proofInvocationFactory?: ProofInvocationFactoryInterface;
  provingProvider: ProofProviderInterface | ProofProviderConfig;
  discoveryProvider: DiscoveryProviderInterface | DiscoveryProviderConfig;
  poolContractAddress: StarknetAddress;
}): PrivateTransfersInterface {
  const provingProvider: ProofProviderInterface = isProofProviderConfig(params.provingProvider)
    ? new ProvingServiceProofProvider(params.provingProvider.url, params.provingProvider.chainId, {
        requestTimeoutMs: params.provingProvider.requestTimeoutMs,
        blockIdentifier: params.provingProvider.blockIdentifier,
        nodeUrl: params.provingProvider.nodeUrl,
        poolAddress: params.poolContractAddress,
        ohttp: params.provingProvider.ohttp,
      })
    : params.provingProvider;

  const discoveryProvider: DiscoveryProviderInterface = isDiscoveryProviderConfig(
    params.discoveryProvider
  )
    ? new IndexerDiscoveryProvider(params.discoveryProvider.url, params.poolContractAddress)
    : params.discoveryProvider;

  return new PrivateTransfers({
    ...params,
    provingProvider,
    discoveryProvider,
    proofInvocationFactory: params.proofInvocationFactory ?? new ProofInvocationFactory(),
  });
}
