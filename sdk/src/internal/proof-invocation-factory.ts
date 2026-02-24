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
import { CallData, hash } from "starknet";

import { serializeClientActions } from "./serialization.js";
import { PrivacyPoolABI } from "./abi.js";
import type {
  ProofInvocation,
  ProofInvocationFactoryDetails,
  StarknetAddress,
} from "../interfaces.js";
import { toBigInt } from "../utils/crypto.js";
import { ClientAction } from "./client-actions.js";
import { toHex } from "../utils/convert.js";

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
 * Build __execute__ calldata wrapping a single Call to execute_view.
 * Layout: [array_len=1, to, selector, inner_calldata_len, ...inner_calldata]
 */
export function compileExecuteCalldata(
  poolAddress: string,
  executeViewCalldata: string[]
): string[] {
  const callDataCompiler = new CallData(PrivacyPoolABI);
  return callDataCompiler.compile("__execute__", [
    [
      {
        to: poolAddress,
        selector: hash.getSelectorFromName("execute_view"),
        calldata: executeViewCalldata,
      },
    ],
  ]);
}

/**
 * Extract inner execute_view calldata from __execute__'s Array<Call> calldata.
 * Layout: [array_len=1, to, selector, inner_calldata_len, ...inner_calldata]
 */
export function extractExecuteViewCalldata(executeCalldata: string[]): string[] {
  const innerCalldataLength = Number(BigInt(executeCalldata[3]));
  return executeCalldata.slice(4, 4 + innerCalldataLength);
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
    const poolAddressHex = toHex(poolAddress);

    const executeViewCalldata = callDataCompiler.compile("execute_view", [
      userAddress,
      user.viewingKey,
      cairoActions,
    ]);
    const compiledCalldata = compileExecuteCalldata(poolAddressHex, executeViewCalldata);

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
        walletAddress: toHex(user.address),
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
