/**
 * Account-funded deposit helper — utilities to build the `.invoke()` callback for depositing
 * funds held by a SNIP-9–capable account into a fresh open note in the caller's own channel,
 * routed through the `DepositAnonymizer`. See `buildAccountDepositInvoke` for details.
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
  type CallDetails,
  type OutsideExecutionOptions,
  type OutsideTransaction,
  type SignerInterface,
} from "starknet";

import type { InvokeCalldataBuilderArgs, StarknetAddress } from "../interfaces.js";
import { generateRandom } from "../utils/crypto.js";
import { toBigInt, toHex } from "../utils/convert.js";

const UDC_ADDRESS = constants.LegacyUDC.ADDRESS;
const UDC_ENTRYPOINT = constants.LegacyUDC.ENTRYPOINT;
const MAX_U64 = 2n ** 64n - 1n;

/**
 * Compute the deterministic Starknet address of a UDC-deployed contract.
 *
 * Convenience wrapper around `hash.calculateContractAddressFromHash` mirroring what the on-chain
 * UDC computes. Callers can derive the same address with starknet.js primitives directly.
 *
 * - `unique = false`: `calculateContractAddressFromHash(salt, classHash, constructorCalldata, 0)`.
 * - `unique = true`:  `calculateContractAddressFromHash(pedersen(deployerAddress, salt), classHash, constructorCalldata, UDC_ADDRESS)`.
 */
export function calculateAccountAddress(params: {
  classHash: BigNumberish;
  constructorCalldata: BigNumberish[];
  salt?: BigNumberish;
  unique?: boolean;
  deployerAddress?: BigNumberish;
}): StarknetAddress {
  const salt = params.salt ?? 0n;
  if (params.unique) {
    if (params.deployerAddress === undefined) {
      throw new Error("calculateAccountAddress: deployerAddress is required when unique=true");
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

/** Inputs for `buildAccountDepositInvoke`. */
export type AccountDepositParams = {
  /** Address of the deployed `DepositAnonymizer` contract for this pool. */
  depositAnonymizerAddress: StarknetAddress;
  /** Chain id used in the SNIP-9 typed-data domain. */
  chainId: constants.StarknetChainId;
  /** The SNIP-9-capable account holding the funds. */
  accountAddress: StarknetAddress;
  /** ERC-20 to deposit. */
  token: StarknetAddress;
  /** Amount to deposit. */
  amount: bigint;
  /** Signs the SNIP-9 OutsideExecution typed data with the account's private key. */
  signer: Pick<SignerInterface, "signMessage">;
  /**
   * If provided, fold a UDC `deployContract` call into the anonymizer's calls array. The SDK
   * derives the address from these fields and throws if it does not match `accountAddress`.
   * Useful when `accountAddress` is a fresh ephemeral account that has not been deployed yet.
   */
  deploy?: {
    classHash: BigNumberish;
    constructorCalldata: BigNumberish[];
    /** Defaults to 0. */
    salt?: BigNumberish;
    /** Defaults to false. */
    unique?: boolean;
    /** Required iff `unique === true`. */
    deployerAddress?: BigNumberish;
  };
  /**
   * Optional SNIP-9 OutsideExecution knobs. Defaults to a random nonce, no expiry, and the
   * `DepositAnonymizer` address as `caller`. The anonymizer is the only contract that invokes
   * `execute_from_outside_v2` here, so that's the tightest valid binding.
   */
  outsideExecution?: {
    nonce?: BigNumberish;
    executeAfter?: BigNumberish;
    executeBefore?: BigNumberish;
    /** Defaults to the `DepositAnonymizer` address. Pass `ANY_CALLER` to widen. */
    caller?: StarknetAddress;
  };
};

/** Inputs for `buildAccountDepositInvoke` — same fields as `AccountDepositParams`. */
export type AccountDepositInvokeParams = AccountDepositParams;

/**
 * Build the `.invoke()` callback for an account-funded deposit.
 *
 * Wire-up with the builder:
 *
 * ```ts
 * const cb = buildAccountDepositInvoke({ ... });
 * await transfers.build()
 *   .with(token, t => t.transfer({ recipient: transfers.user, amount: Open }))
 *   .invoke(cb)
 *   .execute();
 * ```
 *
 * Signing the SNIP-9 typed data happens **inside** the returned async callback, after the open
 * note id has been minted upstream. This binds the user's signature to `note_id`, which closes a
 * front-running hole where an attacker could otherwise capture the signed outside execution and
 * re-route the deposit into a different note.
 *
 * ## Flow
 *
 * On submission, `pool.apply_actions(...)` runs the pool's `InvokeExternal` action, which calls
 * `DepositAnonymizer.privacy_invoke(calls)`. The anonymizer dispatches:
 *
 *   1. (optional) `UDC.deployContract(...)` deploys `A` if `params.deploy` is set.
 *   2. `A.execute_from_outside_v2(payload, sig)` — `A`'s two signed inner calls run as `A`:
 *        a. `token.approve(anonymizer, amount)` — authorizes the anonymizer to pull funds.
 *        b. `anonymizer.deposit_to_open_note(note_id, token, amount)` — pulls funds from `A` via
 *           `transferFrom` and returns an `OpenNoteDeposit`.
 *
 * The anonymizer parses that `OpenNoteDeposit` out of the SNIP-9 return chain, approves the pool
 * to pull the deposit amount, and returns `[OpenNoteDeposit { note_id, token, amount }]`. The
 * pool's `_apply_invoke` then performs `transferFrom(anonymizer, pool, amount)` to fill the open
 * note.
 *
 * Because `note_id` is part of the *inner* `deposit_to_open_note` calldata, the user's SNIP-9
 * signature commits to it — a front-runner cannot swap it out without invalidating the signature.
 *
 * ```mermaid
 * sequenceDiagram
 *     actor Submitter
 *     participant Pool as Privacy Pool
 *     participant Anon as DepositAnonymizer
 *     participant UDC
 *     participant A as Account A (SNIP-9)
 *     participant ERC20
 *
 *     Submitter->>Pool: apply_actions(server_actions, proof)
 *     Note over Pool: CreateOpenNote (note_id)
 *     Pool->>Anon: privacy_invoke(calls)
 *
 *     opt params.deploy
 *         Anon->>UDC: deployContract(...)
 *         UDC->>A: deploys
 *     end
 *
 *     Anon->>A: execute_from_outside_v2(payload, signature)
 *     A->>ERC20: approve(Anon, amount)
 *     A->>Anon: deposit_to_open_note(note_id, token, amount)
 *     Anon->>ERC20: transferFrom(A, Anon, amount)
 *
 *     Anon->>ERC20: approve(Pool, amount)
 *     Anon-->>Pool: [OpenNoteDeposit { note_id, token, amount }]
 *
 *     Note over Pool: _apply_invoke loops deposits
 *     Pool->>ERC20: transferFrom(Anon, Pool, amount)
 *     Note over Pool: open note filled
 * ```
 */
export function buildAccountDepositInvoke(
  params: AccountDepositInvokeParams
): (args: InvokeCalldataBuilderArgs) => Promise<CallDetails> {
  if (params.deploy) {
    const derived = calculateAccountAddress(params.deploy);
    if (toBigInt(derived) !== toBigInt(params.accountAddress)) {
      throw new Error(
        `buildAccountDepositInvoke: accountAddress ${toHex(params.accountAddress)} does not match address derived from \`deploy\` (${toHex(derived)})`
      );
    }
    if (params.deploy.unique && params.deploy.deployerAddress === undefined) {
      throw new Error(
        "buildAccountDepositInvoke: deployerAddress is required when deploy.unique=true"
      );
    }
  }

  const anonymizerHex = toHex(params.depositAnonymizerAddress);
  const accountAddressHex = toHex(params.accountAddress);
  const tokenHex = toHex(params.token);
  const tokenBigInt = toBigInt(params.token);

  return async ({ openNotes }: InvokeCalldataBuilderArgs): Promise<CallDetails> => {
    const openNoteForToken = openNotes.find((note) => note.token === tokenBigInt);
    if (!openNoteForToken) {
      throw new Error(
        `buildAccountDepositInvoke: no open note found for token ${tokenHex}; ` +
          `add a CreateOpenNote action for that token before .invoke()`
      );
    }
    const noteIdHex = toHex(openNoteForToken.noteId);

    // A's signed inner calls: approve the anonymizer, then call `deposit_to_open_note`, which
    // pulls funds via `transferFrom` and returns an `OpenNoteDeposit` propagated up the SNIP-9
    // return chain.
    const approveInner: Call = {
      contractAddress: tokenHex,
      entrypoint: "approve",
      calldata: CallData.compile([anonymizerHex, uint256.bnToUint256(params.amount)]),
    };
    const depositInner: Call = {
      contractAddress: anonymizerHex,
      entrypoint: "deposit_to_open_note",
      calldata: CallData.compile([noteIdHex, tokenHex, params.amount]),
    };
    const innerCalls: Call[] = [approveInner, depositInner];

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
    const signature = await params.signer.signMessage(typedData, accountAddressHex);

    const outsideTransaction: OutsideTransaction = {
      outsideExecution: {
        caller: callOptions.caller,
        nonce,
        execute_after: callOptions.execute_after,
        execute_before: callOptions.execute_before,
        calls: innerCalls.map((call) => snip9.getOutsideCall(call)),
      },
      signature,
      signerAddress: accountAddressHex,
      version: OutsideExecutionVersion.V2,
    };
    const [executeFromOutsideCall] = snip9.buildExecuteFromOutsideCall(outsideTransaction);

    // privacy_invoke calls array: [optional UDC.deploy, A.execute_from_outside_v2]. The
    // anonymizer parses the deposit out of the SNIP-9 return chain and approves the pool itself,
    // so we no longer push a standalone `token.approve(pool, ...)` call here.
    const calls: Call[] = [];
    if (params.deploy) {
      const { classHash, constructorCalldata, salt, unique } = params.deploy;
      calls.push({
        contractAddress: UDC_ADDRESS,
        entrypoint: UDC_ENTRYPOINT,
        calldata: CallData.compile([classHash, salt ?? 0n, unique ? 1n : 0n, constructorCalldata]),
      });
    }
    calls.push(executeFromOutsideCall);

    return {
      contractAddress: anonymizerHex,
      calldata: serializePrivacyInvokeCalldata(calls),
    };
  };
}

/**
 * Serialize `(calls: Array<Call>)` as Cairo wire calldata for
 * `DepositAnonymizer.privacy_invoke`. Each `Call` is `(to, selector, len_inner, ...inner)`. The
 * outer array is length-prefixed.
 */
function serializePrivacyInvokeCalldata(calls: Call[]): BigNumberish[] {
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
