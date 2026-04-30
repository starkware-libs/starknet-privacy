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
  PrivateTransfersUser,
} from "./interfaces.js";
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

export interface CreatePrivateTransfersParams {
  /**
   * Minimal user identity used to sign proof invocations. A full `Account`
   * instance is structurally assignable here, since it exposes both `address`
   * and `signer`. For smart wallets where account-level signature wrapping
   * (e.g. owner + guardian merge) lives outside the signer, supply a custom
   * `signer` implementation instead of `account.signer`.
   */
  user: PrivateTransfersUser;
  viewingKeyProvider: ViewingKeyProvider;
  proofInvocationFactory?: ProofInvocationFactoryInterface;
  provingProvider: ProofProviderInterface | ProofProviderConfig;
  discoveryProvider: DiscoveryProviderInterface | DiscoveryProviderConfig;
  poolContractAddress: StarknetAddress;
}

/**
 * Creates a new PrivateTransfers instance for interacting with the privacy pool.
 *
 * You can pass either **instances** (e.g. mocks or your own implementations) or **configs**
 * for the production proving and discovery providers. When you pass a config, the factory
 * creates the corresponding production implementation (ProvingServiceProofProvider /
 * IndexerDiscoveryProvider) for you.
 *
 * @param params - Configuration object containing user, providers (or configs), and pool address
 * @returns A PrivateTransfers instance
 *
 * @example With instances (e.g. mocks)
 * ```typescript
 * const privateTransfers = createPrivateTransfers({
 *   user: { address: myAddress, signer: mySigner },
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
 *   user: { address: myAddress, signer: mySigner },
 *   viewingKeyProvider: { getViewingKey: async () => myPrivateKey },
 *   provingProvider: { url: "https://prover.example.com", chainId: constants.StarknetChainId.SN_MAIN },
 *   discoveryProvider: { url: "https://indexer.example.com" },
 *   poolContractAddress: poolAddress,
 * });
 * ```
 *
 * @example With a full Account instance (structurally assignable)
 * ```typescript
 * const account = new Account(provider, address, privateKey);
 * const privateTransfers = createPrivateTransfers({
 *   user: account,
 *   // ...
 * });
 * ```
 */
export function createPrivateTransfers(
  params: CreatePrivateTransfersParams
): PrivateTransfersInterface {
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
    user: params.user,
    viewingKeyProvider: params.viewingKeyProvider,
    provingProvider,
    discoveryProvider,
    proofInvocationFactory: params.proofInvocationFactory ?? new ProofInvocationFactory(),
    poolContractAddress: params.poolContractAddress,
  });
}
