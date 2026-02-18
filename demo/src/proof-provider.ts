import type { RpcProvider, constants } from "starknet";
// Direct import avoids pulling in Node-only modules from the testing barrel
// @ts-expect-error — deep import into dist, not part of the declared exports
import { CallMockProofProvider } from "starknet-sdk/dist/testing/mock-proving.js";
import type {
  Proof,
  ProofInvocation,
  ProofInvocationFactoryDetails,
  ProofProviderInterface,
} from "starknet-sdk";

/**
 * Proof provider that calls execute_view directly (view function, no signature).
 * The standard CallMockProofProvider uses account.execute which requires
 * is_valid_signature — not available on all account types.
 */
export class NoValidateProofProvider implements ProofProviderInterface {
  private readonly delegate: CallMockProofProvider;

  constructor(
    private readonly provider: RpcProvider,
    chainId: constants.StarknetChainId,
  ) {
    this.delegate = new CallMockProofProvider(provider, chainId);
  }

  getDefaultDetails(): ProofInvocationFactoryDetails {
    return this.delegate.getDefaultDetails();
  }

  async prove(invocation: ProofInvocation): Promise<Proof> {
    const result = await this.provider.callContract({
      contractAddress: invocation.contractAddress,
      entrypoint: "execute_view",
      calldata: invocation.calldata!,
    });
    return { output: result, data: undefined!, proofFacts: [] };
  }
}
