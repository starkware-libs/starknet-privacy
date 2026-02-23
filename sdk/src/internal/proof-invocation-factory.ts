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
import type { constants } from "starknet";
import { CallData, ETransactionVersion } from "starknet";

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

/** Default L2 gas max amount for proof invocations */
const DEFAULT_L2_GAS_MAX_AMOUNT = 10_000_000n;

/** Hardcoded nonce for proof invocations (no chain fetch). */
const PROOF_INVOCATION_NONCE = 0n;

/**
 * Build default proof invocation factory details for a given chain.
 * Plain helper so providers only need to pass their chainId.
 */
export function getDefaultProofDetails(
  chainId: constants.StarknetChainId
): ProofInvocationFactoryDetails {
  return {
    versions: [ETransactionVersion.V3],
    nonce: PROOF_INVOCATION_NONCE,
    skipValidate: true,
    resourceBounds: {
      l1_gas: { max_amount: 1n, max_price_per_unit: 0n },
      l2_gas: { max_amount: DEFAULT_L2_GAS_MAX_AMOUNT, max_price_per_unit: 0n },
      l1_data_gas: { max_amount: 1n, max_price_per_unit: 0n },
    },
    tip: 0n,
    paymasterData: [],
    accountDeploymentData: [],
    nonceDataAvailabilityMode: "L1",
    feeDataAvailabilityMode: "L1",
    version: ETransactionVersion.V3,
    chainId,
  };
}

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
    const compiledCalldata = callDataCompiler.compile("execute_view", [
      userAddress,
      user.viewingKey,
      cairoActions,
    ]);
    const poolAddressHex = toHex(poolAddress);

    // Sign the transaction using details from the proof provider
    // TODO: Build the tx once (here) and pass it to the proving service provider.
    const signature = await user.signer.signTransaction(
      [
        {
          contractAddress: poolAddressHex,
          entrypoint: "execute_view",
          calldata: compiledCalldata,
        },
      ],
      {
        walletAddress: poolAddressHex,
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
