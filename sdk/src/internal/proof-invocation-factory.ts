/**
 * ProofInvocationFactory - Creates invocation data for proving.
 *
 * Abstracts how client actions are transformed into data for the proof provider.
 * - Starknet implementation: serializes to Cairo calldata and builds an invocation
 * - Mock implementation: passes through client actions directly
 */

import type {
  BigNumberish,
  CallResult,
  SignerInterface,
  V3InvocationsSignerDetails,
} from "starknet";
import { CallData, num } from "starknet";

import { serializeClientActions } from "./serialization.js";
import { PrivacyPoolABI } from "./abi.js";
import type {
  ProofInvocation,
  ProofInvocationFactoryDetails,
  StarknetAddress,
} from "../interfaces.js";
import { toBigInt } from "../utils/crypto.js";
import { ClientAction } from "./client-actions.js";

/**
 * Minimal user info needed for creating a proof invocation.
 */
export interface ProofUser {
  address: BigNumberish;
  signer: SignerInterface;
  viewingKey: BigNumberish;
}

/**
 * Factory interface for creating proof invocation data.
 */
export interface ProofInvocationFactoryInterface {
  create(
    user: ProofUser,
    poolAddress: StarknetAddress,
    clientActions: ClientAction[],
    details: ProofInvocationFactoryDetails
  ): Promise<ProofInvocation>;

  /**
   * Parse proof output for logging/debugging.
   * Returns the decoded server actions.
   */
  parseOutput(output: string[]): CallResult;
}

/**
 * Starknet implementation - serializes client actions to an invocation with signature.
 */
export class ProofInvocationFactory implements ProofInvocationFactoryInterface {
  async create(
    user: ProofUser,
    poolAddress: StarknetAddress,
    clientActions: ClientAction[],
    details: ProofInvocationFactoryDetails
  ): Promise<ProofInvocation> {
    const cairoActions = serializeClientActions(clientActions);
    const callDataCompiler = new CallData(PrivacyPoolABI);
    const userAddress = toBigInt(user.address);
    const compiledCalldata = callDataCompiler.compile("__execute__", [
      userAddress,
      user.viewingKey,
      cairoActions,
    ]);
    const poolAddressHex = num.toHex(poolAddress);

    // Sign the transaction using details from the proof provider
    const signature = await user.signer.signTransaction(
      [
        {
          contractAddress: poolAddressHex,
          entrypoint: "__execute__",
          calldata: compiledCalldata,
        },
      ],
      {
        walletAddress: num.toHex(user.address),
        cairoVersion: "1",
        ...details,
      } as V3InvocationsSignerDetails
    );

    return {
      contractAddress: poolAddressHex,
      calldata: compiledCalldata,
      signature: signature as string[],
    };
  }

  parseOutput(output: string[]): CallResult {
    const decoder = new CallData(PrivacyPoolABI);
    return decoder.decodeParameters("core::array::Span::<privacy::actions::ServerAction>", output);
  }
}
