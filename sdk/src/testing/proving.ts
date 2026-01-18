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
      entrypoint: "__execute__",
      calldata: invocation.calldata,
    });

    // TODO: slice(1) is a hack to get the actual serialized ServerActions.
    // The __execute__ return value is Span<felt252>, which gets wrapped with a length prefix.
    // We need to skip the first element (span length) to get the actual serialized ServerActions.
    return { output: result.slice(1), outputHash: undefined!, data: undefined! };
  }
}
