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
import type { Account, AccountInterface } from "starknet";
import { PrivateTransfers } from "./internal/private-transfers.js";

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
 *   poolAccount: poolAccount,
 * });
 * ```
 */
export function createPrivateTransfers(params: {
  account: Account;
  viewingKeyProvider: ViewingKeyProvider;
  provingProvider: ProofProviderInterface;
  discoveryProvider: DiscoveryProviderInterface;
  poolContractAddress: StarknetAddress;
  poolAccount: AccountInterface;
}): PrivateTransfersInterface {
  return new PrivateTransfers(params);
}
