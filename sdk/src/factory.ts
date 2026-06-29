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
import type { PoolCapabilityMode } from "./internal/pool-mode.js";
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
   * Identity used to sign proof invocations. Only `address` and `signer` are
   * read, so a full starknet.js `Account` is structurally assignable here as
   * well as a minimal `{ address, signer }` object. For smart wallets where
   * account-level signature wrapping (e.g. owner + guardian merge) lives
   * outside the signer, supply a custom `signer` implementation rather than
   * passing the full `Account`.
   */
  account: PrivateTransfersUser;
  viewingKeyProvider: ViewingKeyProvider;
  proofInvocationFactory?: ProofInvocationFactoryInterface;
  provingProvider: ProofProviderInterface | ProofProviderConfig;
  discoveryProvider: DiscoveryProviderInterface | DiscoveryProviderConfig;
  poolContractAddress: StarknetAddress;
  /**
   * Overrides class-hash pool-mode detection — for pools whose class hash
   * isn't pinned in the SDK (e.g. source-built devnet/test pools).
   */
  poolMode?: PoolCapabilityMode;
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
 * @example With a full Account
 * ```typescript
 * const account = new Account(provider, address, privateKey);
 * const privateTransfers = createPrivateTransfers({
 *   account,
 *   viewingKeyProvider: { getViewingKey: async () => myPrivateKey },
 *   provingProvider: { url: "https://prover.example.com", chainId: constants.StarknetChainId.SN_MAIN },
 *   discoveryProvider: { url: "https://indexer.example.com" },
 *   poolContractAddress: poolAddress,
 * });
 * ```
 *
 * @example With a minimal `{ address, signer }` (e.g. smart wallets that wrap signing)
 * ```typescript
 * const privateTransfers = createPrivateTransfers({
 *   account: { address: myAddress, signer: customProofSigner },
 *   viewingKeyProvider: { getViewingKey: async () => myPrivateKey },
 *   provingProvider: new MockProofProvider(pool),
 *   discoveryProvider: new ContractDiscoveryProvider(pool),
 *   poolContractAddress: poolAddress,
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
        retry: params.provingProvider.retry,
      })
    : params.provingProvider;

  const discoveryProvider: DiscoveryProviderInterface = isDiscoveryProviderConfig(
    params.discoveryProvider
  )
    ? new IndexerDiscoveryProvider(params.discoveryProvider.url, params.poolContractAddress)
    : params.discoveryProvider;

  return new PrivateTransfers({
    account: params.account,
    viewingKeyProvider: params.viewingKeyProvider,
    provingProvider,
    discoveryProvider,
    proofInvocationFactory: params.proofInvocationFactory ?? new ProofInvocationFactory(),
    poolContractAddress: params.poolContractAddress,
    poolMode: params.poolMode,
  });
}
