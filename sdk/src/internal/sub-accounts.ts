import { BigNumberish, Call, CairoCustomEnum, CallData, hash, shortString } from "starknet";
import type {
  CollectPolicy,
  ComputeAndInvokeDetails,
  InvokeCalldataBuilderArgs,
  PrivateTransfersBuilder,
  StarknetAddress,
  SubAccountsBuilder,
  ViewingKey,
} from "../interfaces.js";
import { SubAccountAnonymizerABI } from "./anonymizer-abi.js";
import { hash as poseidonHash, toBigInt, toHex } from "../utils/index.js";
import { compute_identity_key } from "../utils/hashes.js";

/** Encodes a dapp name to a felt: a string is a Cairo short string, a felt passes through. */
function encodeDappName(dappName: string | BigNumberish): bigint {
  return typeof dappName === "string"
    ? toBigInt(shortString.encodeShortString(dappName))
    : toBigInt(dappName);
}

export class SubAccountsBuilderImpl implements SubAccountsBuilder {
  private readonly dappName: bigint;
  private readonly subAccountAnonymizerAddress: bigint;

  constructor(
    private readonly params: {
      builder: PrivateTransfersBuilder;
      dappName: string | BigNumberish;
      subAccountAnonymizerAddress: StarknetAddress;
      user: bigint;
      getViewingKey: () => Promise<ViewingKey>;
    }
  ) {
    this.dappName = encodeDappName(params.dappName);
    this.subAccountAnonymizerAddress = toBigInt(params.subAccountAnonymizerAddress);
  }

  invoke(
    nonce: BigNumberish,
    options: { calls: Call[]; collectPolicy?: CollectPolicy }
  ): PrivateTransfersBuilder {
    const { dappName, subAccountAnonymizerAddress } = this;
    const nonceFelt = toBigInt(nonce);
    // The anonymizer's `privacy_invoke_with_computation` takes Cairo `Call`s (to/selector/calldata).
    const anonymizerCalls = options.calls.map((call) => ({
      to: call.contractAddress,
      selector: hash.getSelectorFromName(call.entrypoint),
      calldata: CallData.compile(call.calldata ?? []),
    }));
    // One CollectPolicy applies to every open note settled by this invoke (default: collect all).
    const collectPolicy = toCollectPolicyEnum(options.collectPolicy ?? { type: "all" });

    return this.params.builder.computeAndInvoke(
      (args: InvokeCalldataBuilderArgs): ComputeAndInvokeDetails => {
        const openNotes = args.openNotes.map((note) => ({
          note_id: note.noteId,
          token: note.token,
          collect_policy: collectPolicy,
        }));
        // Compile (calls, open_notes) via the ABI and drop the leading identity_commitment felt,
        // which the pool prepends from the privacy_compute result.
        const invokeAdditionalData = new CallData(SubAccountAnonymizerABI)
          .compile("privacy_invoke_with_computation", [0n, anonymizerCalls, openNotes])
          .slice(1)
          .map(toBigInt);
        return {
          contractAddress: toHex(subAccountAnonymizerAddress),
          computeAdditionalData: [dappName, nonceFelt],
          invokeAdditionalData,
        };
      }
    );
  }

  async partialCommitment(): Promise<bigint> {
    const viewingKey = await this.params.getViewingKey();
    const identityKey = compute_identity_key(
      this.params.user,
      toBigInt(viewingKey),
      this.subAccountAnonymizerAddress
    );
    return poseidonHash(identityKey, this.dappName);
  }

  async commitment(nonce: BigNumberish): Promise<bigint> {
    return poseidonHash(await this.partialCommitment(), toBigInt(nonce));
  }
}

/** Map a {@link CollectPolicy} to the anonymizer's `CollectPolicy` Cairo enum for calldata. */
function toCollectPolicyEnum(policy: CollectPolicy): CairoCustomEnum {
  return new CairoCustomEnum({
    All: policy.type === "all" ? {} : undefined,
    Diff: policy.type === "diff" ? {} : undefined,
    Exact: policy.type === "exact" ? policy.amount : undefined,
  });
}
