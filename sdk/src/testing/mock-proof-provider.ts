/**
 * MockProofProvider - Proof provider for mock testing.
 *
 * Uses MockPoolContract to execute client actions and returns the
 * MockServerAction[] callbacks as the proof output.
 */

import type {
  Proof,
  ProofProviderInterface,
  ProofInvocation,
  ProofInvocationFactoryDetails,
} from "../interfaces.js";
import type { ClientAction } from "../internal/client-actions.js";
import type { MockPoolContract } from "./mock-pool-contract.js";
import { bigintReviver } from "./mock-proof-invocation-factory.js";
import { ETransactionVersion } from "starknet";

/**
 * Mock proof provider that executes actions on MockPoolContract.
 *
 * The invocation data is expected to be ProofInvocation with calldata
 * containing [userAddress, JSON.stringify(clientActions)].
 * The provider:
 * 1. Parses the invocation to get user address and client actions
 * 2. Executes the actions (getting callbacks)
 * 3. Returns callbacks in proof.output
 */
export class MockProofProvider implements ProofProviderInterface {
  constructor(private pool: MockPoolContract) {}

  getDefaultDetails(): ProofInvocationFactoryDetails {
    return {
      versions: [ETransactionVersion.V3],
      nonce: 0n,
      skipValidate: true,
      resourceBounds: {
        l1_gas: { max_amount: 0n, max_price_per_unit: 0n },
        l2_gas: { max_amount: 0n, max_price_per_unit: 0n },
        l1_data_gas: { max_amount: 0n, max_price_per_unit: 0n },
      },
      tip: 0n,
      paymasterData: [],
      accountDeploymentData: [],
      nonceDataAvailabilityMode: "L1",
      feeDataAvailabilityMode: "L1",
      version: ETransactionVersion.V3,
      chainId: "0x0", // Mock chain ID
    };
  }

  async prove(invocation: ProofInvocation): Promise<Proof> {
    // Parse the calldata from MockProofInvocationFactory
    // Format: [userAddress, JSON.stringify(clientActions)]
    const calldata = invocation.calldata as string[];
    const userAddress = BigInt(calldata[0]);
    const clientActions: ClientAction[] = JSON.parse(calldata[1], bigintReviver);

    // Execute on mock pool - returns MockServerAction[] (serialized as string[])
    const callbacks = this.pool.execute(userAddress, ...clientActions);

    return {
      data: new Uint8Array([0, 1, 2, 3]),
      outputHash: "0x0",
      // Store callbacks in output (duck-typed, will be extracted by MockPublicCallBuilder)
      output: callbacks as unknown as string[],
    };
  }
}
