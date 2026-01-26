/**
 * Mock ProofInvocationFactory implementation for testing.
 *
 * Simply passes through the client actions without serialization.
 * The MockProofProvider will use these directly with MockPoolContract.
 */

import type { ClientAction } from "../internal/client-actions.js";
import type {
  ProofInvocationFactoryInterface,
  ProofUser,
} from "../internal/proof-invocation-factory.js";
import type {
  ProofInvocation,
  ProofInvocationFactoryDetails,
  StarknetAddress,
} from "../interfaces.js";
import type { CallResult } from "starknet";
import { num } from "starknet";

/**
 * Mock implementation - creates a minimal ProofInvocation for testing.
 * The calldata contains just the user address and client actions for the mock pool.
 */
export class MockProofInvocationFactory implements ProofInvocationFactoryInterface {
  async create(
    user: ProofUser,
    poolAddress: StarknetAddress,
    clientActions: ClientAction[],
    _details: ProofInvocationFactoryDetails
  ): Promise<ProofInvocation> {
    // For mock, we store the client actions in a way the mock pool can use
    // The mock proof provider will extract and process these
    const poolAddressHex = num.toHex(poolAddress);
    return {
      contractAddress: poolAddressHex,
      calldata: [num.toHex(user.address), JSON.stringify(clientActions)],
      signature: [],
    };
  }

  parseOutput(output: string[]): CallResult {
    // Mock output is already in a usable format
    return output;
  }
}
