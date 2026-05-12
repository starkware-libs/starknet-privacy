/**
 * Account-funded deposit helper — utilities to build the `.invoke()` callback for depositing
 * funds held by a SNIP-9–capable account into a fresh open note in the caller's own channel,
 * routed through the generic `CallAnonymizer`. See `buildAccountDepositInvoke` for details.
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

/** Inputs for `buildAccountDepositInvoke`. */
export type AccountDepositParams = {
  /** Address of the deployed `CallAnonymizer` contract for this pool. */
  callAnonymizerAddress: StarknetAddress;
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
   * `CallAnonymizer` address as `caller`. The anonymizer is the only contract that invokes
   * `execute_from_outside_v2` here, so that's the tightest valid binding.
   */
  outsideExecution?: {
    nonce?: BigNumberish;
    executeAfter?: BigNumberish;
    executeBefore?: BigNumberish;
    /** Defaults to the `CallAnonymizer` address. Pass `ANY_CALLER` to widen. */
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
 * const cb = await buildAccountDepositInvoke({ ... });
 * await transfers.build()
 *   .with(token, t => t.transfer({ recipient: transfers.user, amount: Open }))
 *   .invoke(cb)
 *   .execute();
 * ```
 *
 * The SNIP-9 typed data is signed inside this function (once, async); the returned callback is
 * synchronous and produces the anonymizer's `privacy_invoke` calldata by injecting the
 * just-minted note id into the `deposits` array.
 *
 * ## Flow
 *
 * On submission, `pool.apply_actions(...)` runs the pool's `InvokeExternal` action, which calls
 * `CallAnonymizer.privacy_invoke(calls, deposits)`. The anonymizer dispatches:
 *
 *   1. (optional) `UDC.deployContract(...)` deploys `A` if `params.deploy` is set.
 *   2. `A.execute_from_outside_v2(payload, sig)` — `A`'s signed inner call
 *      `token.transfer(anonymizer, amount)` moves funds onto the anonymizer.
 *   3. `token.approve(pool, amount)` — the anonymizer authorizes the pool to pull.
 *
 * The anonymizer returns `[OpenNoteDeposit { note_id, token, amount }]`; the pool's
 * `_apply_invoke` then performs `transferFrom(anonymizer, pool, amount)` to fill the open note.
 *
 * ```mermaid
 * sequenceDiagram
 *     actor Submitter
 *     participant Pool as Privacy Pool
 *     participant Anon as CallAnonymizer
 *     participant UDC
 *     participant A as Account A (SNIP-9)
 *     participant ERC20
 *
 *     Submitter->>Pool: apply_actions(server_actions, proof)
 *     Note over Pool: CreateOpenNote (note_id)
 *     Pool->>Anon: privacy_invoke(calls, deposits)
 *
 *     opt params.deploy
 *         Anon->>UDC: deployContract(...)
 *         UDC->>A: deploys
 *     end
 *
 *     Anon->>A: execute_from_outside_v2(payload, signature)
 *     A->>ERC20: transfer(Anon, amount)
 *
 *     Anon->>ERC20: approve(Pool, amount)
 *     Anon-->>Pool: [OpenNoteDeposit { note_id, token, amount }]
 *
 *     Note over Pool: _apply_invoke loops deposits
 *     Pool->>ERC20: transferFrom(Anon, Pool, amount)
 *     Note over Pool: open note filled
 * ```
 *
 * ## Note: unfilled open notes
 *
 * If the privacy pool supports the unfilled-open-notes feature (i.e. a public
 * `deposit_to_open_note(note_id, token, amount)` entrypoint that checks
 * `caller == note.depositor`), the funds-transit step through the anonymizer is no longer
 * required. In that variant, `A`'s SNIP-9 inner calls could be
 * `[token.approve(pool, amount), pool.deposit_to_open_note(note_id, token, amount)]` — running
 * with `caller = A` they would match a `depositor = A` open note and fill it directly. The
 * anonymizer's intermediate `transfer` → `approve` → pool-`transferFrom` round-trip is only
 * needed when the pool can fill an open note solely from its own `_apply_invoke` loop.
 */
export async function buildAccountDepositInvoke(
  params: AccountDepositInvokeParams
): Promise<(args: InvokeCalldataBuilderArgs) => CallDetails> {
  if (params.deploy) {
    const derived = calculateEphemeralAddress(params.deploy);
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

  const anonymizerHex = toHex(params.callAnonymizerAddress);
  const accountAddressHex = toHex(params.accountAddress);
  const tokenHex = toHex(params.token);
  const tokenBigInt = toBigInt(params.token);

  // The inner call A signs: push funds to the anonymizer. The anonymizer's subsequent approve
  // call (also dispatched via privacy_invoke) authorizes the pool to pull those funds.
  const innerTransferCall: Call = {
    contractAddress: tokenHex,
    entrypoint: "transfer",
    calldata: CallData.compile([anonymizerHex, uint256.bnToUint256(params.amount)]),
  };
  const innerCalls: Call[] = [innerTransferCall];

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

  return ({ openNotes, poolAddress }: InvokeCalldataBuilderArgs): CallDetails => {
    const openNoteForToken = openNotes.find((note) => note.token === tokenBigInt);
    if (!openNoteForToken) {
      throw new Error(
        `buildAccountDepositInvoke: no open note found for token ${tokenHex}; ` +
          `add a CreateOpenNote action for that token before .invoke()`
      );
    }
    const poolHex = toHex(poolAddress);

    // privacy_invoke calls array: [optional UDC.deploy, A.execute_from_outside_v2, approve].
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
    calls.push({
      contractAddress: tokenHex,
      entrypoint: "approve",
      calldata: CallData.compile([poolHex, uint256.bnToUint256(params.amount)]),
    });

    // deposits: a single OpenNoteDeposit matching the open note created upstream.
    const deposits = [
      { note_id: toHex(openNoteForToken.noteId), token: tokenHex, amount: params.amount },
    ];

    return {
      contractAddress: anonymizerHex,
      calldata: serializePrivacyInvokeCalldata(calls, deposits),
    };
  };
}

/**
 * Serialize `(calls: Array<Call>, deposits: Array<OpenNoteDeposit>)` as Cairo wire calldata for
 * `CallAnonymizer.privacy_invoke`. Each `Call` is `(to, selector, len_inner, ...inner)`; each
 * `OpenNoteDeposit` is `(note_id, token, amount)`. Both arrays are length-prefixed.
 */
function serializePrivacyInvokeCalldata(
  calls: Call[],
  deposits: { note_id: string; token: string; amount: bigint }[]
): BigNumberish[] {
  const out: BigNumberish[] = [calls.length];
  for (const call of calls) {
    const inner = CallData.compile(call.calldata ?? []);
    out.push(toHex(call.contractAddress));
    out.push(hash.getSelectorFromName(call.entrypoint));
    out.push(inner.length);
    out.push(...inner);
  }
  out.push(deposits.length);
  for (const d of deposits) {
    out.push(d.note_id);
    out.push(d.token);
    out.push(d.amount);
  }
  return out;
}
