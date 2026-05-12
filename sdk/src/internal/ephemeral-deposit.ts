/**
 * Ephemeral-account deposit flow (SNIP-9).
 *
 * Builds the calls needed to deposit funds held by a fresh ephemeral SNIP-9
 * account `A` into an open note in the caller's own channel. Submitted as a
 * single multicall by any wallet:
 *   1. pool.apply_actions(...)                    — open note with depositor = A
 *   2. (optional) UDC.deployContract(...)         — deploys A if needed
 *   3. A.execute_from_outside_v2(payload, sig)    — inner calls run with caller = A
 *      where the inner calls are
 *        [erc20.approve(pool, amount), pool.deposit_to_open_note(noteId, token, amount)]
 *
 * The signature over the SNIP-9 OutsideExecution typed data is produced by a
 * caller-supplied `signer` (any object satisfying `Pick<SignerInterface,
 * "signMessage">`). The SDK does not touch the ephemeral private key.
 */

import {
  CallData,
  constants,
  hash,
  outsideExecution as snip9,
  OutsideExecutionVersion,
  uint256,
  type BigNumberish,
  type Call,
  type OutsideExecutionOptions,
  type OutsideTransaction,
} from "starknet";

import { Open } from "../interfaces.js";
import type {
  EphemeralDepositParams,
  EphemeralDepositResult,
  ExecuteOptions,
  PrivateTransfersInterface,
  StarknetAddress,
} from "../interfaces.js";
import { generateRandom } from "../utils/crypto.js";
import { toBigInt, toHex } from "../utils/convert.js";
import { PrivacyPoolABI } from "./abi.js";

const ANY_CALLER = constants.OutsideExecutionCallerAny;
const UDC_ADDRESS = constants.LegacyUDC.ADDRESS;
const UDC_ENTRYPOINT = constants.LegacyUDC.ENTRYPOINT;
const MAX_U64 = 2n ** 64n - 1n;

/**
 * Compute the deterministic Starknet address of a UDC-deployed contract.
 *
 * Mirrors what the on-chain UDC computes when called with the same arguments.
 * Convenience wrapper around `hash.calculateContractAddressFromHash`; callers
 * can derive the same address using starknet.js primitives directly.
 *
 * - `unique = false`: address = `calculateContractAddressFromHash(salt, classHash, constructorCalldata, 0)`.
 * - `unique = true`:  address = `calculateContractAddressFromHash(pedersen(deployerAddress, salt), classHash, constructorCalldata, UDC_ADDRESS)`.
 */
export function calculateEphemeralAddress(params: {
  classHash: BigNumberish;
  constructorCalldata: BigNumberish[];
  salt?: BigNumberish;
  unique?: boolean;
  deployerAddress?: BigNumberish;
}): StarknetAddress {
  const salt = params.salt ?? 0n;
  if (params.unique) {
    if (params.deployerAddress === undefined) {
      throw new Error("calculateEphemeralAddress: deployerAddress is required when unique=true");
    }
    const mixedSalt = hash.computePedersenHash(toHex(params.deployerAddress), toHex(salt));
    return hash.calculateContractAddressFromHash(
      mixedSalt,
      params.classHash,
      params.constructorCalldata,
      UDC_ADDRESS
    );
  }
  return hash.calculateContractAddressFromHash(
    salt,
    params.classHash,
    params.constructorCalldata,
    0
  );
}

/**
 * See `PrivateTransfersInterface.createEphemeralDeposit`.
 *
 * `poolAddress` and `chainId` are supplied by the wrapping `PrivateTransfers`
 * (which knows them from its construction params); accepted here so the helper
 * stays usable standalone.
 */
export async function createEphemeralDeposit(
  transfers: PrivateTransfersInterface,
  poolAddress: StarknetAddress,
  chainId: constants.StarknetChainId,
  params: EphemeralDepositParams,
  options?: ExecuteOptions
): Promise<EphemeralDepositResult> {
  // 1. Verify the derived address when `deploy` is provided, to catch caller mistakes.
  if (params.deploy) {
    const derived = calculateEphemeralAddress(params.deploy);
    if (toBigInt(derived) !== toBigInt(params.ephemeralAddress)) {
      throw new Error(
        `createEphemeralDeposit: ephemeralAddress ${toHex(params.ephemeralAddress)} does not match address derived from \`deploy\` (${toHex(derived)})`
      );
    }
  }

  // 2. Compile + prove the open-note creation via the builder.
  const executed = await transfers
    .build(options)
    .with(params.token)
    .transfer({
      recipient: transfers.user,
      amount: Open,
      depositor: params.ephemeralAddress,
    })
    .execute();
  if (executed.openNoteIds.length !== 1) {
    throw new Error(
      `createEphemeralDeposit: expected 1 open note, got ${executed.openNoteIds.length}`
    );
  }
  const noteId = executed.openNoteIds[0];

  // 4. Inner calls that A will execute via outside execution.
  const approveCall: Call = {
    contractAddress: toHex(params.token),
    entrypoint: "approve",
    calldata: CallData.compile([toHex(poolAddress), uint256.bnToUint256(params.amount)]),
  };
  const depositCall: Call = {
    contractAddress: toHex(poolAddress),
    entrypoint: "deposit_to_open_note",
    calldata: new CallData(PrivacyPoolABI).compile("deposit_to_open_note", [
      noteId,
      params.token,
      params.amount,
    ]),
  };
  const innerCalls: Call[] = [approveCall, depositCall];

  // 5. Sign the SNIP-9 OutsideExecution typed data with the ephemeral key.
  const callOptions: OutsideExecutionOptions = {
    caller: params.outsideExecution?.caller ? toHex(params.outsideExecution.caller) : ANY_CALLER,
    execute_after: params.outsideExecution?.executeAfter ?? 0n,
    execute_before: params.outsideExecution?.executeBefore ?? MAX_U64,
  };
  const nonce = params.outsideExecution?.nonce ?? generateRandom();
  const typedData = snip9.getTypedData(
    chainId,
    callOptions,
    nonce,
    innerCalls,
    OutsideExecutionVersion.V2
  );
  const ephemeralAddressHex = toHex(params.ephemeralAddress);
  const signature = await params.signer.signMessage(typedData, ephemeralAddressHex);

  // 6. Build the outer call to A.execute_from_outside_v2.
  const outsideTransaction: OutsideTransaction = {
    outsideExecution: {
      caller: callOptions.caller,
      nonce,
      execute_after: callOptions.execute_after,
      execute_before: callOptions.execute_before,
      calls: innerCalls.map((call) => snip9.getOutsideCall(call)),
    },
    signature,
    signerAddress: ephemeralAddressHex,
    version: OutsideExecutionVersion.V2,
  };
  const [executeFromOutsideCall] = snip9.buildExecuteFromOutsideCall(outsideTransaction);

  // 7. Optional UDC deploy call.
  const calls: Call[] = [executed.callAndProof.call];
  if (params.deploy) {
    const { classHash, constructorCalldata, salt, unique, deployerAddress } = params.deploy;
    if (unique && deployerAddress === undefined) {
      throw new Error(
        "createEphemeralDeposit: deployerAddress is required when deploy.unique=true"
      );
    }
    calls.push({
      contractAddress: UDC_ADDRESS,
      entrypoint: UDC_ENTRYPOINT,
      calldata: CallData.compile([classHash, salt ?? 0n, unique ? 1n : 0n, constructorCalldata]),
    });
  }
  calls.push(executeFromOutsideCall);

  return {
    ephemeralAddress: params.ephemeralAddress,
    noteId,
    proof: executed.callAndProof.proof,
    calls,
    registry: executed.registry,
    warnings: executed.warnings,
  };
}
