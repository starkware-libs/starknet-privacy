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
} from "../interfaces.js";
import type { TypedContractV2 } from "starknet";
import { ActionCompiler } from "./compiler.js";
import { PrivacyPoolABI } from "./abi.js";
import { AbstractPrivateTransfers } from "./abstract-private-transfers.js";
import { debugLog } from "../utils/logging.js";
import type { AccountSignerRaw } from "../interfaces.js";
import type { ProofInvocationFactoryInterface } from "./proof-invocation-factory.js";
import { toHex } from "../utils/convert.js";
import { buildProofFacts } from "../utils/proof-facts.js";

// Export the specific typed contract type for the Privacy Pool
export type PrivacyPoolContract = TypedContractV2<typeof PrivacyPoolABI>;

export class PrivateTransfers extends AbstractPrivateTransfers {
  constructor(
    private readonly params: {
      account: AccountSignerRaw; // the user account (for signing)
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

  async execute(actions: Actions, options?: ExecuteOptions): Promise<ExecuteResult> {
    // Get viewing key for both compiler and calldata
    const viewingKey = await this.params.viewingKeyProvider.getViewingKey();
    const compiler = new ActionCompiler(this.user, viewingKey, this.params.discoveryProvider);

    // Compile actions
    const { clientActions, registry, warnings } = await compiler.compile(actions, options);

    const details = this.params.provingProvider.getDefaultDetails();
    const invocation = await this.params.proofInvocationFactory.create(
      { address: this.params.account.address, signer: this.params.account.signer, viewingKey },
      this.params.poolContractAddress,
      clientActions,
      details
    );

    // Get proof from provider
    const proof = await this.params.provingProvider.prove(invocation);

    // Parse and log server actions for debugging
    const parsedOutput = () => this.params.proofInvocationFactory.parseOutput(proof.output);
    debugLog("private-transfers", "execute", "parsed server actions", parsedOutput);

    // Build proof facts for on-chain validation (requires a real provider)
    let proofFacts: string[] | undefined;
    if (typeof this.params.account.getBlock === "function") {
      const latestBlock = await this.params.account.getBlock("latest");
      const currentBlockNumber = BigInt(latestBlock.block_number);
      // Blockifier requires base_block_number to be at least STORED_BLOCK_HASH_BUFFER (10)
      // blocks behind the current block, and the block must have a non-zero stored hash.
      // TODO: Consider lowering this buffer to account for proving time, or making it configurable.
      const baseBlockNumber = currentBlockNumber > 10n ? currentBlockNumber - 10n : 1n;
      const baseBlock = await this.params.account.getBlock(Number(baseBlockNumber));
      const chainId = await this.params.account.getChainId();
      proofFacts = buildProofFacts(
        this.params.poolContractAddress,
        proof.output,
        baseBlockNumber,
        baseBlock.block_hash ?? "0x0",
        chainId
      );
    }

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
