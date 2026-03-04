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
} from "../interfaces.js";
import type { Account, TypedContractV2 } from "starknet";
import { ActionCompiler } from "./compiler.js";
import { PrivacyPoolABI } from "./abi.js";
import { AbstractPrivateTransfers } from "./abstract-private-transfers.js";
import { debugLog } from "../utils/logging.js";
import type { ProofInvocationFactoryInterface } from "./proof-invocation-factory.js";
import { toHex } from "../utils/convert.js";

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
    return new ActionCompiler(this.user, viewingKey, this.params.discoveryProvider);
  }

  async createProofInvocation(
    actions: Actions,
    options?: ExecuteOptions
  ): Promise<ProofInvocationResult> {
    // Get viewing key for both compiler and calldata
    const viewingKey = await this.params.viewingKeyProvider.getViewingKey();
    const compiler = new ActionCompiler(this.user, viewingKey, this.params.discoveryProvider);

    // Compile actions
    const { clientActions, registry, warnings } = await compiler.compile(actions, options);

    // Create invocation for proving
    const details = this.params.provingProvider.getDefaultDetails();
    const invocation = await this.params.proofInvocationFactory.create(
      { address: this.params.account.address, signer: this.params.account.signer, viewingKey },
      this.params.poolContractAddress,
      clientActions,
      details
    );

    return { invocation, registry, warnings };
  }

  async execute(actions: Actions, options?: ExecuteOptions): Promise<ExecuteResult> {
    const { invocation, registry, warnings } = await this.createProofInvocation(actions, options);

    // Get proof from provider (block id only when provided in options)
    const proof = await this.params.provingProvider.prove(invocation, options?.provingBlockId);

    // Parse and log server actions for debugging
    const parsedOutput = () => this.params.proofInvocationFactory.parseOutput(proof.output);
    debugLog("private-transfers", "execute", "parsed server actions", parsedOutput);

    return {
      callAndProof: {
        call: {
          contractAddress: toHex(this.params.poolContractAddress),
          entrypoint: "apply_actions",
          calldata: proof.output,
        },
        proof,
      },
      registry,
      warnings,
    };
  }
}
