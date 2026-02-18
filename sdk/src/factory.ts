/**
 * Factory functions for creating SDK instances.
 */

import type {
  PrivateTransfersInterface,
  ViewingKeyProvider,
  ProofProviderInterface,
  DiscoveryProviderInterface,
  StarknetAddress,
} from "./interfaces.js";
import { PrivateTransfers } from "./internal/private-transfers.js";
import type { AccountSignerRaw } from "./interfaces.js";
import {
  ProofInvocationFactory,
  type ProofInvocationFactoryInterface,
} from "./internal/proof-invocation-factory.js";

/**
 * Creates a new PrivateTransfers instance for interacting with the privacy pool.
 *
 * @param params - Configuration object containing account, providers, and pool address
 * @returns A PrivateTransfers instance
 *
 * @example
 * ```typescript
 * const privateTransfers = createPrivateTransfers({
 *   account: myAccount,
 *   viewingKeyProvider: { getViewingKey: () => myPrivateKey },
 *   provingProvider: myProvingProvider,
 *   discoveryProvider: myDiscoveryProvider,
 *   poolContractAddress: poolAddress,
 * });
 * ```
 */
export function createPrivateTransfers(params: {
  account: AccountSignerRaw;
  viewingKeyProvider: ViewingKeyProvider;
  proofInvocationFactory?: ProofInvocationFactoryInterface;
  provingProvider: ProofProviderInterface;
  discoveryProvider: DiscoveryProviderInterface;
  poolContractAddress: StarknetAddress;
}): PrivateTransfersInterface {
  return new PrivateTransfers({
    ...params,
    proofInvocationFactory: params.proofInvocationFactory ?? new ProofInvocationFactory(),
  });
}
