/**
 * Real PrivateTransfers implementation using Starknet contracts.
 */

import type {
  Actions,
  ExecuteOptions,
  ExecuteResult,
  FeeProviderInterface,
  PreviewResult,
  ProofProviderInterface,
  DiscoveryProviderInterface,
  ViewingKeyProvider,
  StarknetAddress,
  StarknetAddressBigint,
  ProofInvocationResult,
} from "../interfaces.js";
import type { Account, TypedContractV2 } from "starknet";
import { ActionCompiler } from "./compiler.js";
import { PrivacyPoolABI } from "./abi.js";
import { AbstractPrivateTransfers } from "./abstract-private-transfers.js";
import { debugLog } from "../utils/logging.js";
import type { ProofInvocationFactoryInterface } from "./proof-invocation-factory.js";
import { toBigInt, toHex } from "../utils/convert.js";
import { estimatePaymasterFee } from "./paymaster/fee-estimator.js";

/**
 * Resolve the fee token: explicit paymasterFeeToken, or the first token in the actions.
 * Throws if neither is available.
 */
function resolveFeeToken(options: ExecuteOptions, actions: Actions): StarknetAddressBigint {
  if (options.paymasterFeeToken !== undefined) {
    return toBigInt(options.paymasterFeeToken);
  }

  const firstToken =
    actions.deposits?.[0]?.token ??
    actions.useNotes?.[0]?.token ??
    actions.createNotes?.[0]?.token ??
    actions.withdraws?.[0]?.token;

  if (firstToken !== undefined) {
    return firstToken;
  }

  throw new Error(
    "autoPaymaster is enabled but no fee token could be determined. " +
      "Set paymasterFeeToken in execute options, or include at least one token operation."
  );
}

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
      feeProvider?: FeeProviderInterface;
    }
  ) {
    super(params.account.address, params.viewingKeyProvider, params.discoveryProvider);
  }

  async preview(actions: Actions, options?: ExecuteOptions): Promise<PreviewResult> {
    if (!options?.autoPaymaster || !this.params.feeProvider) {
      return { actions, fee: 0n };
    }

    const feeToken = resolveFeeToken(options, actions);
    const feeSchedule = await this.params.feeProvider.getFeeQuote(feeToken);
    const fee = estimatePaymasterFee(actions, feeSchedule, options.autoSetup);

    return { actions, fee, feeSchedule };
  }

  async createProofInvocation(
    actions: Actions,
    options?: ExecuteOptions
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
    if (options?.autoPaymaster) {
      await this.injectPaymasterFee(actions, options);
    }

    const { invocation, registry, warnings } = await this.createProofInvocation(actions, options);

    // Get proof from provider (block id only when provided in options)
    const proof = await this.params.provingProvider.prove(invocation, options?.provingBlockId);

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

  /**
   * Estimate the paymaster fee and inject a fee withdrawal into the actions.
   * Mutates `actions.withdraws` before compilation so autoSelectNotes accounts for the fee.
   */
  private async injectPaymasterFee(actions: Actions, options: ExecuteOptions): Promise<void> {
    if (!this.params.feeProvider) {
      throw new Error(
        "autoPaymaster is enabled but no feeProvider is configured. " +
          "Pass a feeProvider (or PaymasterConfig) when creating PrivateTransfers."
      );
    }

    const feeToken = resolveFeeToken(options, actions);
    const feeSchedule = await this.params.feeProvider.getFeeQuote(feeToken);
    const fee = estimatePaymasterFee(actions, feeSchedule, options.autoSetup);

    actions.withdraws ??= [];
    actions.withdraws.push({
      recipient: toBigInt(feeSchedule.feeRecipient),
      token: feeToken,
      amount: fee,
    });
  }
}
