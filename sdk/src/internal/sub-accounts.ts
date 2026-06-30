import { BigNumberish, Call, CallData, hash, shortString } from "starknet";
import type {
  ComputeAndInvokeDetails,
  InvokeCalldataBuilderArgs,
  PrivateTransfersBuilder,
  PrivateTransfersInterface,
  StarknetAddress,
  StarknetAddressBigint,
  SubAccount,
  SubAccountsBuilder,
} from "../interfaces.js";
import { SubAccountAnonymizerABI } from "./anonymizer-abi.js";
import { toBigInt, toHex } from "../utils/index.js";

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
      transfers: PrivateTransfersInterface;
      dappName: string | BigNumberish;
      subAccountAnonymizerAddress: StarknetAddress;
    }
  ) {
    this.dappName = encodeDappName(params.dappName);
    this.subAccountAnonymizerAddress = toBigInt(params.subAccountAnonymizerAddress);
  }

  invoke(nonce: BigNumberish, options: { calls: Call[] }): PrivateTransfersBuilder {
    const { dappName, subAccountAnonymizerAddress } = this;
    const nonceFelt = toBigInt(nonce);
    // The anonymizer's `privacy_invoke_with_computation` takes Cairo `Call`s (to/selector/calldata).
    const anonymizerCalls = options.calls.map((call) => ({
      to: call.contractAddress,
      selector: hash.getSelectorFromName(call.entrypoint),
      calldata: CallData.compile(call.calldata ?? []),
    }));

    return this.params.transfers
      .build()
      .computeAndInvoke((args: InvokeCalldataBuilderArgs): ComputeAndInvokeDetails => {
        const openNotes = args.openNotes.map((note) => ({
          note_id: note.noteId,
          token: note.token,
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
      });
  }

  async identify(_nonce: BigNumberish): Promise<StarknetAddressBigint> {
    throw new Error("SubAccountsBuilder.identify() is not implemented yet.");
  }

  async deployed(_opts?: { startNonce?: number; maxNonce?: number }): Promise<SubAccount[]> {
    throw new Error("SubAccountsBuilder.deployed() is not implemented yet.");
  }
}
