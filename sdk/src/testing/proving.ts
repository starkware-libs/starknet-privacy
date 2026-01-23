/**
 * Call-based proving provider for testing
 *
 * This provider simulates proof generation by making a call to the contract
 * to execute the invocation and capture the output.
 */

import type { Invocation, ProviderInterface } from "starknet";
import type { Proof, ProofProviderInterface } from "../interfaces.js";

/**
 * A proving provider that uses Starknet calls to simulate proof generation.
 * This is useful for testing where we want to execute the contract logic
 * without actually generating zero-knowledge proofs.
 */
export class CallMockProofProvider implements ProofProviderInterface {
  constructor(private readonly provider: ProviderInterface) {}

  async prove(invocation: Invocation): Promise<Proof> {
    const result = await this.provider.callContract({
      contractAddress: invocation.contractAddress,
      entrypoint: "execute_view",
      calldata: invocation.calldata,
    });

    // execute_view returns Span<ServerAction> which is serialized with its length prefix.
    // execute_actions also expects Span<ServerAction> with the length prefix, so we pass it through as-is.
    return { output: result, outputHash: undefined!, data: undefined! };
  }
}
