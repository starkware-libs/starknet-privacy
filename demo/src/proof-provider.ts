import type { RpcProvider, constants } from "starknet";
// Direct import avoids pulling in Node-only modules from the testing barrel
// @ts-expect-error — deep import into dist, not part of the declared exports
import { CallMockProofProvider } from "starknet-sdk/dist/testing/mock-proving.js";
// @ts-expect-error — deep import into dist, not part of the declared exports
import { extractExecuteViewCalldata } from "starknet-sdk/dist/internal/proof-invocation-factory.js";
import type {
  Proof,
  ProofInvocation,
  ProofInvocationFactoryDetails,
  ProofProviderInterface,
} from "starknet-sdk";

/**
 * Proof provider that calls `compile_actions` directly as a view (no signature).
 * The standard CallMockProofProvider validates the user's signature via
 * `is_valid_signature` first, which isn't available on all account types.
 */
export class NoValidateProofProvider implements ProofProviderInterface {
  private readonly delegate: CallMockProofProvider;

  constructor(
    private readonly provider: RpcProvider,
    chainId: constants.StarknetChainId
  ) {
    this.delegate = new CallMockProofProvider(provider, chainId);
  }

  async getDefaultDetails(): Promise<ProofInvocationFactoryDetails> {
    return this.delegate.getDefaultDetails();
  }

  async prove(invocation: ProofInvocation): Promise<Proof> {
    // invocation.calldata is the __execute__ Array<Call> wrapper around compile_actions.
    const executeViewCalldata = extractExecuteViewCalldata(
      invocation.calldata as string[]
    );
    const result = await this.provider.callContract({
      contractAddress: invocation.sender_address,
      entrypoint: "compile_actions",
      calldata: executeViewCalldata,
    });
    // Real provers return [class_hash, ...serialized_actions] — prepend the
    // class hash so executeWithInvocation can strip it back off.
    const classHash = await this.provider.getClassHashAt(
      invocation.sender_address
    );
    return {
      output: [classHash, ...result],
      data: undefined!,
      proofFacts: [],
    };
  }
}
