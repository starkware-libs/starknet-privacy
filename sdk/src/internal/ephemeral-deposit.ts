/**
 * Ephemeral-account deposit flow via the generic `CallAnonymizer`.
 *
 * Builds the calls needed to deposit funds held by a fresh ephemeral SNIP-9 account `A` into an
 * open note in the caller's own channel. The open note is created with `depositor = A`, and
 * `apply_actions` invokes the anonymizer via `privacy_invoke` with a calls array of (optionally)
 * `[UDC.deployContract(...), A.execute_from_outside_v2(...)]`. The user-signed SNIP-9
 * `OutsideExecution` runs `[token.approve(pool, amount), pool.deposit_to_open_note(note_id, token,
 * amount)]` from `A`, which fills the note in the same transaction.
 *
 * Outer multicall produced by `createEphemeralDeposit`: just `[pool.apply_actions(...)]`. The
 * UDC deploy is folded into the `privacy_invoke` calls array.
 */

import {
  CallData,
  constants,
  hash,
  outsideExecution as snip9,
  OutsideExecutionVersion,
  type BigNumberish,
  type Call,
  type CallDetails,
  type OutsideExecutionOptions,
} from "starknet";

import { Open } from "../interfaces.js";
import type {
  EphemeralDepositParams,
  EphemeralDepositResult,
  ExecuteOptions,
  InvokeCalldataBuilderArgs,
  PrivateTransfersInterface,
  StarknetAddress,
} from "../interfaces.js";
import { PrivacyPoolABI } from "./abi.js";
import { generateRandom } from "../utils/crypto.js";
import { toBigInt, toHex } from "../utils/convert.js";

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
 * Inputs for `buildEphemeralDepositInvoke`.
 *
 * Defaults: the SNIP-9 `caller` binds to `anonymizerAddress`, `nonce` is random, `executeAfter`
 * is `0`, `executeBefore` is `u64::MAX`. `deploy` is optional and, when present, prepends a UDC
 * deploy call before the outside-execution call inside `privacy_invoke`'s calls array.
 */
export type EphemeralDepositInvokeParams = {
  anonymizerAddress: StarknetAddress;
  ephemeralAddress: StarknetAddress;
  token: StarknetAddress;
  amount: bigint;
  signer: EphemeralDepositParams["signer"];
  chainId: constants.StarknetChainId;
  outsideExecution?: EphemeralDepositParams["outsideExecution"];
  deploy?: EphemeralDepositParams["deploy"];
};

/**
 * Build the async `.invoke()` callback for an ephemeral-account deposit.
 *
 * The callback is async because the SNIP-9 typed data includes the `note_id` of the open note
 * created by the same `apply_actions`, which is only known after compilation.
 *
 * Use with the builder:
 *
 * ```ts
 * await transfers.build()
 *   .with(token, t => t.transfer({
 *     recipient: transfers.user,
 *     amount: Open,
 *     depositor: ephemeralAddress,
 *   }))
 *   .invoke(buildEphemeralDepositInvoke({ ... }))
 *   .execute();
 * ```
 *
 * The signed inner calls are `[token.approve(pool, amount), pool.deposit_to_open_note(note_id,
 * token, amount)]`. The `privacy_invoke` calls array is
 * `[UDC.deployContract?, A.execute_from_outside_v2(...)]`.
 */
export function buildEphemeralDepositInvoke(
  params: EphemeralDepositInvokeParams
): (args: InvokeCalldataBuilderArgs) => Promise<CallDetails> {
  const anonymizerHex = toHex(params.anonymizerAddress);
  const ephemeralAddressHex = toHex(params.ephemeralAddress);
  const tokenHex = toHex(params.token);
  const tokenBigInt = toBigInt(params.token);

  return async ({ openNotes, poolAddress }: InvokeCalldataBuilderArgs): Promise<CallDetails> => {
    const openNoteForToken = openNotes.find((note) => note.token === tokenBigInt);
    if (!openNoteForToken) {
      throw new Error(
        `buildEphemeralDepositInvoke: no open note found for token ${tokenHex} in this transaction; ` +
          `add a CreateOpenNote action with depositor = ${ephemeralAddressHex} before .invoke()`
      );
    }
    const poolHex = toHex(poolAddress);
    const noteId = openNoteForToken.noteId;

    // Inner calls A signs and executes inside execute_from_outside_v2:
    // approve the pool, then push the funds straight into the open note. Both run with
    // caller=A, which matches the note's depositor and lets pool.deposit_to_open_note pass its
    // `caller == depositor` check.
    const approveCall: Call = {
      contractAddress: tokenHex,
      entrypoint: "approve",
      calldata: CallData.compile([poolHex, params.amount.toString(), "0"]),
    };
    const depositCall: Call = {
      contractAddress: poolHex,
      entrypoint: "deposit_to_open_note",
      calldata: new CallData(PrivacyPoolABI).compile("deposit_to_open_note", [
        noteId,
        params.token,
        params.amount,
      ]),
    };
    const innerCalls: Call[] = [approveCall, depositCall];

    const callerHex = params.outsideExecution?.caller
      ? toHex(params.outsideExecution.caller)
      : anonymizerHex;
    const callOptions: OutsideExecutionOptions = {
      caller: callerHex,
      execute_after: params.outsideExecution?.executeAfter ?? 0n,
      execute_before: params.outsideExecution?.executeBefore ?? MAX_U64,
    };
    const nonce = params.outsideExecution?.nonce ?? generateRandom();

    const typedData = snip9.getTypedData(
      params.chainId,
      callOptions,
      nonce,
      innerCalls,
      OutsideExecutionVersion.V2
    );
    const signature = await params.signer.signMessage(typedData, ephemeralAddressHex);

    // Build A.execute_from_outside_v2(outside_execution, signature) via starknet.js so the
    // calldata encoding matches what the OZ SRC9 entry point expects.
    const [executeFromOutsideCall] = snip9.buildExecuteFromOutsideCall({
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
    });

    // Assemble the privacy_invoke calls array. UDC.deploy goes first (when present) so A
    // exists before the anonymizer syscalls into it.
    const calls: Call[] = [];
    if (params.deploy) {
      const { classHash, constructorCalldata, salt, unique, deployerAddress } = params.deploy;
      if (unique && deployerAddress === undefined) {
        throw new Error(
          "buildEphemeralDepositInvoke: deployerAddress is required when deploy.unique=true"
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
      contractAddress: anonymizerHex,
      calldata: serializeCallsArray(calls),
    };
  };
}

/**
 * Serialize an array of starknet.js `Call` objects as a Cairo `Array<Call>` (the calldata
 * expected by `CallAnonymizer.privacy_invoke`).
 *
 * Cairo wire format per `Call { to: ContractAddress, selector: felt252, calldata: Span<felt252> }`
 * inside `Array<T>` is: `[len_calls, (to, selector, len_inner_calldata, ...inner_calldata)…]`.
 */
function serializeCallsArray(calls: Call[]): BigNumberish[] {
  const out: BigNumberish[] = [calls.length];
  for (const call of calls) {
    const inner = CallData.compile(call.calldata ?? []);
    out.push(toHex(call.contractAddress));
    out.push(hash.getSelectorFromName(call.entrypoint));
    out.push(inner.length);
    out.push(...inner);
  }
  return out;
}

/**
 * See `PrivateTransfersInterface.createEphemeralDeposit`.
 *
 * `anonymizerAddress` and `chainId` are supplied by the wrapping `PrivateTransfers` (which knows
 * them from its construction params); accepted here so the helper stays usable standalone.
 */
export async function createEphemeralDeposit(
  transfers: PrivateTransfersInterface,
  anonymizerAddress: StarknetAddress,
  chainId: constants.StarknetChainId,
  params: EphemeralDepositParams,
  options?: ExecuteOptions
): Promise<EphemeralDepositResult> {
  if (params.deploy) {
    const derived = calculateEphemeralAddress(params.deploy);
    if (toBigInt(derived) !== toBigInt(params.ephemeralAddress)) {
      throw new Error(
        `createEphemeralDeposit: ephemeralAddress ${toHex(params.ephemeralAddress)} does not match address derived from \`deploy\` (${toHex(derived)})`
      );
    }
    if (params.deploy.unique && params.deploy.deployerAddress === undefined) {
      throw new Error(
        "createEphemeralDeposit: deployerAddress is required when deploy.unique=true"
      );
    }
  }

  const invokeCallback = buildEphemeralDepositInvoke({
    anonymizerAddress,
    ephemeralAddress: params.ephemeralAddress,
    token: params.token,
    amount: params.amount,
    signer: params.signer,
    chainId,
    outsideExecution: params.outsideExecution,
    deploy: params.deploy,
  });

  const executed = await transfers
    .build(options)
    .with(params.token, (t) =>
      t.transfer({
        recipient: transfers.user,
        amount: Open,
        depositor: params.ephemeralAddress,
      })
    )
    .invoke(invokeCallback)
    .execute();

  return {
    ephemeralAddress: params.ephemeralAddress,
    proof: executed.callAndProof.proof,
    calls: [executed.callAndProof.call],
    registry: executed.registry,
    warnings: executed.warnings,
  };
}
