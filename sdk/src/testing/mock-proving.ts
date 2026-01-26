/**
 * Call-based proving provider for testing
 *
 * This provider simulates proof generation by making a call to the contract
 * to execute the invocation and capture the output.
 */

import type { ProviderInterface } from "starknet";
import { ETransactionVersion } from "starknet";
import type {
  Proof,
  ProofProviderInterface,
  ProofInvocation,
  ProofInvocationFactoryDetails,
} from "../interfaces.js";

/**
 * A proving provider that uses Starknet calls to simulate proof generation.
 * This is useful for testing where we want to execute the contract logic
 * without actually generating zero-knowledge proofs.
 */
export class CallMockProofProvider implements ProofProviderInterface {
  constructor(
    private readonly provider: ProviderInterface,
    private readonly chainId: string
  ) {}

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
      chainId: this.chainId,
    };
  }

  async prove(invocation: ProofInvocation): Promise<Proof> {
    const result = await this.provider.callContract({
      contractAddress: invocation.contractAddress,
      entrypoint: "execute_view",
      calldata: invocation.calldata!,
    });

    // execute_view returns Span<ServerAction> which is serialized with its length prefix.
    // execute_actions also expects Span<ServerAction> with the length prefix, so we pass it through as-is.
    return { output: result, outputHash: undefined!, data: undefined! };
  }
}
