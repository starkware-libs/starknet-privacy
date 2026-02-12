/**
 * Abstract base for proof providers with shared getDefaultDetails implementation.
 * Subclasses provide chainId.
 */

import type { constants } from "starknet";
import { ETransactionVersion } from "starknet";
import type {
  Proof,
  ProofInvocation,
  ProofInvocationFactoryDetails,
  ProofProviderInterface,
} from "../interfaces.js";

/** Default L2 gas max amount for proof invocations */
const DEFAULT_L2_GAS_MAX_AMOUNT = 10_000_000n;

/** Hardcoded nonce for proof invocations (no chain fetch). */
const PROOF_INVOCATION_NONCE = 0n;

export abstract class AbstractProofProvider implements ProofProviderInterface {
  /** Subclass must return the chain ID for the invocation. */
  protected abstract getChainId(): constants.StarknetChainId;

  /**
   * Shared default factory details for proof invocations.
   * Same structure for both real and mock providers.
   */
  async getDefaultDetails(): Promise<ProofInvocationFactoryDetails> {
    return this.buildDefaultDetails(this.getChainId());
  }

  /** Build details from chainId and nonce; used by getDefaultDetails. */
  protected buildDefaultDetails(
    chainId: constants.StarknetChainId,
  ): ProofInvocationFactoryDetails {
    return {
      versions: [ETransactionVersion.V3],
      nonce: PROOF_INVOCATION_NONCE,
      skipValidate: true,
      resourceBounds: {
        l1_gas: { max_amount: 0n, max_price_per_unit: 0n },
        l2_gas: { max_amount: DEFAULT_L2_GAS_MAX_AMOUNT, max_price_per_unit: 0n },
        l1_data_gas: { max_amount: 0n, max_price_per_unit: 0n },
      },
      tip: 0n,
      paymasterData: [],
      accountDeploymentData: [],
      nonceDataAvailabilityMode: "L1",
      feeDataAvailabilityMode: "L1",
      version: ETransactionVersion.V3,
      chainId,
    };
  }

  abstract prove(invocation: ProofInvocation): Promise<Proof>;
}
