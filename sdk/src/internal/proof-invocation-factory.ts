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
} from "starknet";
import { CallData, ETransactionVersion3, hash, stark } from "starknet";

import type { SignerRawInterface } from "../interfaces.js";
import { serializeClientActions } from "./serialization.js";
import { PrivacyPoolABI } from "./abi.js";
import type {
  ProofInvocationWithPayload,
  ProofInvocationFactoryDetails,
  StarknetAddress,
} from "../interfaces.js";
import { toBigInt } from "../utils/crypto.js";
import { ClientAction } from "./client-actions.js";
import { toHex } from "../utils/convert.js";

/**
 * Minimal user info needed for creating a proof invocation.
 * The signer must implement SignerRawInterface (e.g. use SignerRaw).
 */
export interface ProofUser {
  address: BigNumberish;
  signer: SignerRawInterface;
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
  ): Promise<ProofInvocationWithPayload>;

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
  ): Promise<ProofInvocationWithPayload> {
    const cairoActions = serializeClientActions(clientActions);
    const callDataCompiler = new CallData(PrivacyPoolABI);
    const userAddress = toBigInt(user.address);
    const compiledCalldata = callDataCompiler.compile("__execute__", [
      userAddress,
      user.viewingKey,
      cairoActions,
    ]);
    const poolAddressHex = toHex(poolAddress);

    // Resolve payload once (same values for hash and for proving-service payload)
    const nonce = toBigInt(details.nonce ?? 0n);
    const resourceBounds = details.resourceBounds ?? stark.zeroResourceBounds();
    const tip = toBigInt(details.tip ?? 0n);
    const paymasterData = details.paymasterData ?? [];
    const accountDeploymentData = details.accountDeploymentData ?? [];
    const nonceDAM = details.nonceDataAvailabilityMode ?? "L1";
    const feeDAM = details.feeDataAvailabilityMode ?? "L1";

    const txHash = hash.calculateInvokeTransactionHash({
      chainId: details.chainId,
      senderAddress: poolAddressHex,
      compiledCalldata,
      version: (details.version ?? ETransactionVersion3.V3) as `${typeof ETransactionVersion3.V3}`,
      nonce,
      accountDeploymentData,
      paymasterData,
      resourceBounds,
      tip,
      nonceDataAvailabilityMode: stark.intDAM(nonceDAM),
      feeDataAvailabilityMode: stark.intDAM(feeDAM),
    });

    const signature = await user.signer.signRaw(txHash);

    return {
      contractAddress: poolAddressHex,
      calldata: compiledCalldata,
      signature: signature as string[],
      nonce,
      resourceBounds,
      tip,
      paymasterData,
      accountDeploymentData,
      nonceDataAvailabilityMode: nonceDAM,
      feeDataAvailabilityMode: feeDAM,
    };
  }

  parseOutput(output: string[]): CallResult {
    const decoder = new CallData(PrivacyPoolABI);
    return decoder.decodeParameters("core::array::Span::<privacy::actions::ServerAction>", output);
  }
}
