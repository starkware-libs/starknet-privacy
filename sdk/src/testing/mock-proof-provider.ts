/**
 * MockProofProvider - Proof provider for mock testing.
 *
 * Uses MockPoolContract to execute client actions and returns the
 * MockServerAction[] callbacks as the proof output.
 */

import type { Proof, ProofInvocation } from "../interfaces.js";
import type { ClientAction } from "../internal/client-actions.js";
import { AbstractProofProvider } from "../internal/abstract-proof-provider.js";
import type { MockPoolContract } from "./mock-pool-contract.js";
import { bigintReviver } from "./mock-proof-invocation-factory.js";
import { constants } from "starknet";

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
export class MockProofProvider extends AbstractProofProvider {
  constructor(private pool: MockPoolContract) {
    super();
  }

  protected getChainId(): constants.StarknetChainId {
    return constants.StarknetChainId.SN_SEPOLIA;
  }

  prove(invocation: ProofInvocation): Proof {
    const calldata = invocation.calldata as string[];
    const userAddress = BigInt(calldata[0]);
    const privateKey = BigInt(calldata[1]);
    const clientActions: ClientAction[] = JSON.parse(calldata[2], bigintReviver);

    // Execute on mock pool - returns MockServerAction[] (serialized as string[])
    const callbacks = this.pool.execute(userAddress, privateKey, ...clientActions);

    return {
      data: ["0x0", "0x1", "0x2", "0x3"] as string[],
      // Store callbacks in output (duck-typed, will be extracted by MockPublicCallBuilder)
      output: callbacks as unknown as string[],
      proofFacts: [],
    };
  }
}
