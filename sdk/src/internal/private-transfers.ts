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
import type { Account, ProviderOrAccount, TypedContractV2 } from "starknet";
import { CallData, Contract, hdParsingStrategy, num } from "starknet";
import { ActionCompiler } from "./compiler.js";
import { PrivacyPoolABI } from "./abi.js";
import { AbstractPrivateTransfers } from "./abstract-private-transfers.js";
import { serializeClientActions } from "./serialization.js";
import { debugLog } from "../utils/logging.js";

// Export the specific typed contract type for the Privacy Pool
export type PrivacyPoolContract = TypedContractV2<typeof PrivacyPoolABI>;

export class PrivateTransfers extends AbstractPrivateTransfers {
  private poolContract: PrivacyPoolContract;

  constructor(
    private readonly params: {
      account: Account; // the user account (for signing)
      viewingKeyProvider: ViewingKeyProvider;
      provingProvider: ProofProviderInterface;
      discoveryProvider: DiscoveryProviderInterface;
      poolContractAddress: StarknetAddress;
      poolAccount: ProviderOrAccount; //account to use to call the pool contract
    }
  ) {
    super(params.account.address, params.viewingKeyProvider, params.discoveryProvider);

    // Create typed contract instance
    this.poolContract = new Contract({
      abi: PrivacyPoolABI,
      address: num.toHex(this.params.poolContractAddress),
      providerOrAccount: this.params.poolAccount,
      parsingStrategy: hdParsingStrategy,
    }).typedv2(PrivacyPoolABI);
  }

  private async getCompiler(): Promise<ActionCompiler> {
    const viewingKey = await this.params.viewingKeyProvider.getViewingKey();
    return new ActionCompiler(this.user, viewingKey, this.params.discoveryProvider);
  }

  async execute(actions: Actions, options?: ExecuteOptions): Promise<ExecuteResult> {
    // Get compiler with current viewing key
    const compiler = await this.getCompiler();

    // Compile actions
    const { clientActions, registry } = await compiler.compile(actions, options);

    // Transform ClientAction[] for Cairo serialization
    const cairoActions = serializeClientActions(clientActions);

    // Use CallData to compile the arguments
    const callDataCompiler = new CallData(PrivacyPoolABI);
    const compiledCalldata = callDataCompiler.compile("__execute__", [this.user, cairoActions]);

    // Create invocation from the populated call (no account abstraction needed for proving)
    const invocation = {
      contractAddress: this.poolContract.address,
      calldata: compiledCalldata,
      entrypoint: "__execute__",
    };
    const proof = await this.params.provingProvider.prove(invocation);

    // The __execute__ return value is Span<felt252>, which gets wrapped with a length prefix.
    // We need to skip the first element (span length) to get the actual serialized ServerActions.

    // Decode the raw felts as Span<ServerAction> to see the structured ServerActions
    // The type string must match the ABI type definition exactly
    const parsedOutput = () => {
      try {
        return callDataCompiler.decodeParameters(
          "core::array::Span::<privacy::actions::ServerAction>",
          proof.output
        );
      } catch (e) {
        return { error: String(e), rawOutput: proof.output };
      }
    };
    debugLog("private-transfers", "execute", "parsed server actions", parsedOutput);

    return {
      callAndProof: {
        call: {
          contractAddress: this.poolContract.address,
          entrypoint: "execute_actions",
          calldata: proof.output,
        },
        proof,
      },
      registry,
    };
  }
}
