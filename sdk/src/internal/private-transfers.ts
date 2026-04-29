/**
 * Real PrivateTransfers implementation using Starknet contracts.
 */

import type {
  Actions,
  ExecuteOptions,
  ExecuteResult,
  ProofProviderInterface,
  DiscoveryProviderInterface,
  ViewingKeyProvider,
  StarknetAddress,
  ProofInvocationResult,
  ProvingBlockId,
} from "../interfaces.js";
import type { Account, TypedContractV2 } from "starknet";
import { ActionCompiler } from "./compiler.js";
import { PrivacyPoolABI } from "./abi.js";
import { AbstractPrivateTransfers } from "./abstract-private-transfers.js";
import { debugLog } from "../utils/logging.js";
import type { ProofInvocationFactoryInterface } from "./proof-invocation-factory.js";
import { toBigInt, toHex } from "../utils/convert.js";

// Export the specific typed contract type for the Privacy Pool
export type PrivacyPoolContract = TypedContractV2<typeof PrivacyPoolABI>;

export class PrivateTransfers extends AbstractPrivateTransfers {
  constructor(
    private readonly params: {
      account: Account; // the user account (for signing)
      viewingKeyProvider: ViewingKeyProvider;
      provingProvider: ProofProviderInterface;
      discoveryProvider: DiscoveryProviderInterface;
      proofInvocationFactory: ProofInvocationFactoryInterface;
      poolContractAddress: StarknetAddress;
    }
  ) {
    super(params.account.address, params.viewingKeyProvider, params.discoveryProvider);
  }

  private async getCompiler(): Promise<ActionCompiler> {
    const viewingKey = await this.params.viewingKeyProvider.getViewingKey();
    return new ActionCompiler(
      this.user,
      viewingKey,
      this.params.discoveryProvider,
      toBigInt(this.params.poolContractAddress)
    );
  }

  async createProofInvocation(
    actions: Actions,
    options?: Omit<ExecuteOptions, "provingBlockId">
  ): Promise<ProofInvocationResult> {
    // Get viewing key for both compiler and calldata
    const viewingKey = await this.params.viewingKeyProvider.getViewingKey();
    const compiler = new ActionCompiler(
      this.user,
      viewingKey,
      this.params.discoveryProvider,
      toBigInt(this.params.poolContractAddress)
    );

    // Compile actions
    const { clientActions, registry, warnings } = await compiler.compile(actions, options);

    // Create invocation for proving
    const details = await this.params.provingProvider.getDefaultDetails();
    const invocation = await this.params.proofInvocationFactory.create(
      { account: this.params.account, viewingKey },
      this.params.poolContractAddress,
      clientActions,
      details
    );

    return { invocation, registry, warnings };
  }

  invalidateProofNonceCache(): void {
    this.params.provingProvider.invalidateNonceCache?.();
  }

  async executeWithInvocation(
    { invocation, registry, warnings }: ProofInvocationResult,
    provingBlockId?: ProvingBlockId
  ): Promise<ExecuteResult> {
    const proof = await this.params.provingProvider.prove(invocation, provingBlockId);

    // proof.output is the L2-to-L1 message payload: [class_hash, ...serialized_actions].
    // Strip the class_hash prefix — apply_actions expects only Span<ServerAction>.
    const serverActionsCalldata = proof.output.slice(1);

    // Parse and log server actions for debugging
    const parsedOutput = () =>
      this.params.proofInvocationFactory.parseOutput(serverActionsCalldata);
    debugLog("private-transfers", "execute", "parsed server actions", parsedOutput);

    return {
      callAndProof: {
        call: {
          contractAddress: toHex(this.params.poolContractAddress),
          entrypoint: "apply_actions",
          calldata: serverActionsCalldata,
        },
        proof,
      },
      registry,
      warnings,
    };
  }
}
