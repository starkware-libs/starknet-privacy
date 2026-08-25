/**
 * The pool's rule for which address a transaction must be screened on, in one place.
 *
 * The pool takes one attestation per transaction and rejects an attestation it has no subject for
 * (`UNEXPECTED_SCREENING`) as firmly as a missing one, so anything deciding what to screen — the
 * proof interceptor in production, the mock proving provider in the devnet suites — has to
 * reproduce this rule exactly. Two copies of it agree only until one of them is edited.
 *
 * What stays with the caller is what the rule does not decide: how the pool call is decoded, where
 * the policy is read from, and what an unresolved subject turns into. The last differs on purpose —
 * the interceptor owes a client an opaque code, a test suite wants a message it can read.
 */

import { CairoCustomEnum, CallData, num } from "starknet";
import { ShadowAccountAnonymizerABI } from "./anonymizer-abi.js";
import {
  shadowAccountAddress,
  shadowAccountCommitment,
  shadowAccountPartialCommitment,
} from "./shadow-account-address.js";

/** The pool's open-note screening policies, in the order its Cairo enum declares them. */
export type OpenNoteScreeningPolicy = "Required" | "Exempt" | "Delegated";

/**
 * The screening subject a transaction puts up. Only `one` and `none` are resolvable; the rest name
 * a transaction that cannot be proven as built, and each caller renders them its own way.
 */
export type ScreeningSubject =
  | { kind: "none" }
  | { kind: "one"; address: string }
  | { kind: "conflict" }
  | { kind: "unreadablePolicy" }
  | { kind: "unknownDelegate" }
  | { kind: "undeterminedShadowAccount" };

/** A decoded pool call: `[user_addr, user_private_key, ...client actions]`. */
export interface DecodedPoolCall {
  /** `user_addr`, the depositor a self-funded deposit proves `TransferFrom.from_addr` against. */
  userAddress: string;
  /**
   * `user_private_key`, the user's viewing key, or `null` when that felt does not parse. A secret:
   * it identifies the user and derives their shadow accounts, so it must never be logged or echoed.
   */
  viewingKey: bigint | null;
  /** The client actions the pool is asked to compile, one enum per action. */
  actions: CairoCustomEnum[];
}

/** Answers the pool's open-note policy for `depositor`, or `null` when the read cannot be made. */
export type OpenNotePolicyReader = (depositor: string) => Promise<OpenNoteScreeningPolicy | null>;

export interface ScreeningSubjectOptions {
  /**
   * The only delegated depositor whose address the caller can derive. A depositor listed
   * `Delegated` that is not it resolves to `unknownDelegate` rather than to a guess.
   */
  anonymizerAddress: string;
}

/** The Invoke target funding a transaction's open notes, and the action driving it. */
interface OpenNoteDepositor {
  address: string;
  isComputeAndInvoke: boolean;
}

/** A shadow account interaction's `privacy_compute` arguments. */
interface ShadowAccountInteraction {
  dappName: bigint;
  nonce: bigint;
}

type DelegatedSubject = Extract<
  ScreeningSubject,
  { kind: "one" | "none" | "unknownDelegate" | "undeterminedShadowAccount" }
>;

const anonymizerDecoder = new CallData(ShadowAccountAnonymizerABI);

/**
 * The parameters of `privacy_compute` and `privacy_invoke_with_computation` that a
 * `ComputeAndInvoke` action supplies, which is all but the leading one of each. The pool prepends
 * the identity key to the first, and to the second the identity commitment `privacy_compute`
 * returned.
 */
const COMPUTE_ARGUMENT_TYPES = anonymizerArgumentTypes("privacy_compute");
const INVOKE_ARGUMENT_TYPES = anonymizerArgumentTypes("privacy_invoke_with_computation");

/**
 * The one address the pool requires an attestation over, or `none` when it requires nothing.
 *
 * Three kinds reach it, at most one per transaction: a `Deposit`'s own depositor, which no policy
 * waives; an Invoke target funding open notes whose policy is `Required`; and the shadow account an
 * interaction runs through when that target's policy is `Delegated`. A transaction putting up two
 * is `conflict` — the pool's `MULTIPLE_SCREENING_SUBJECTS`, reached before it is sent.
 */
export async function screeningSubjectOf(
  poolCall: DecodedPoolCall,
  readPolicy: OpenNotePolicyReader,
  options: ScreeningSubjectOptions
): Promise<ScreeningSubject> {
  const addresses = new Set<string>();

  // A deposit is screened on its own depositor. The policy list does not apply to a `TransferFrom`
  // the user signs for themselves.
  if (poolCall.actions.some((action) => action.activeVariant() === "Deposit")) {
    addresses.add(poolCall.userAddress);
  }

  const depositor = openNoteDepositorOf(poolCall.actions);
  if (depositor !== null) {
    const policy = await readPolicy(depositor.address);
    switch (policy) {
      case "Exempt":
        break;

      case "Required":
        addresses.add(depositor.address);
        break;

      case "Delegated": {
        const delegated = delegatedSubjectOf(poolCall, depositor, options);
        if (delegated.kind === "one") addresses.add(delegated.address);
        else if (delegated.kind !== "none") return delegated;
        break;
      }

      case null:
        return { kind: "unreadablePolicy" };

      default:
        return unscreenableUnderUnhandledPolicy(policy);
    }
  }

  if (addresses.size > 1) return { kind: "conflict" };
  const [address] = addresses;
  return address === undefined ? { kind: "none" } : { kind: "one", address };
}

/**
 * Under the invariant that an open note must be funded within the transaction that creates it, any
 * transaction carrying a `CreateOpenNote` action has an open-note depositor.
 */
export function openNoteDepositorOf(actions: CairoCustomEnum[]): OpenNoteDepositor | null {
  if (!actions.some((action) => action.activeVariant() === "CreateOpenNote")) {
    return null;
  }
  for (const action of actions) {
    const variant = action.activeVariant();
    if (variant !== "InvokeExternal" && variant !== "ComputeAndInvoke") continue;
    const { contract_address: contractAddress } = action.unwrap() as {
      contract_address: bigint;
    };
    return {
      address: normalizeFelt(num.toHex(contractAddress)),
      isComputeAndInvoke: variant === "ComputeAndInvoke",
    };
  }
  return null;
}

/**
 * The address of the shadow account a pool call's interaction runs through, or `null` when the call
 * runs none, or when a felt the derivation needs does not parse.
 *
 * The derivation is local, so it resolves even for an account that is not deployed yet: the
 * anonymizer salts the deploy by the identity commitment and cements `PRIMER_CLASS_HASH`, which
 * keeps the address independent of chain state, and a deployed account sits at the same address.
 *
 * `poolCall.viewingKey` is a secret and stays inside this derivation.
 */
export function shadowAccountOfPoolCall(
  poolCall: DecodedPoolCall,
  anonymizerAddress: string
): string | null {
  if (poolCall.viewingKey === null) return null;
  const interaction = shadowAccountInteractionOf(poolCall.actions, anonymizerAddress);
  if (interaction === null) return null;
  const userAddress = parseFelt(poolCall.userAddress);
  if (userAddress === null) return null;

  const anonymizer = BigInt(normalizeFelt(anonymizerAddress));
  const commitment = shadowAccountCommitment(
    shadowAccountPartialCommitment(
      userAddress,
      poolCall.viewingKey,
      anonymizer,
      interaction.dappName
    ),
    interaction.nonce
  );
  return normalizeFelt(num.toHex(shadowAccountAddress(commitment, anonymizer)));
}

/**
 * The shadow account interaction among `actions`, or `null` when they run none: no
 * `ComputeAndInvoke` targets `anonymizerAddress`, the one that does settles no open note (nothing
 * is deposited, so nobody is screened), or its data does not decode.
 *
 * Undecodable data counts as no interaction rather than as an error, since the pool cannot execute
 * it either and the transaction reverts on its own.
 *
 * The pool accepts at most one invoke-phase action per transaction, so a second `ComputeAndInvoke`
 * makes a transaction the pool rejects whatever this returns. The first one wins here.
 */
export function shadowAccountInteractionOf(
  actions: CairoCustomEnum[],
  anonymizerAddress: string
): ShadowAccountInteraction | null {
  for (const action of actions) {
    if (action.activeVariant() !== "ComputeAndInvoke") continue;
    const input = action.unwrap() as {
      contract_address: bigint;
      compute_additional_data: bigint[];
      invoke_additional_data: bigint[];
    };
    if (normalizeFelt(num.toHex(input.contract_address)) !== normalizeFelt(anonymizerAddress)) {
      continue;
    }
    return interactionArguments(input);
  }
  return null;
}

/** Normalizes a hex felt so `0x01`, `0X1` and `0x001` compare equal. */
export function normalizeFelt(value: string): string {
  const lower = value.toLowerCase();
  const hex = lower.startsWith("0x") ? lower.slice(2) : lower;
  return "0x" + (hex.replace(/^0+/, "") || "0");
}

function parseFelt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** The address a delegated open-note depositor puts up for the deposits its invoke funds. */
function delegatedSubjectOf(
  poolCall: DecodedPoolCall,
  depositor: OpenNoteDepositor,
  { anonymizerAddress }: ScreeningSubjectOptions
): DelegatedSubject {
  // A plain invoke is exempt under `Delegated`; only a compute-invoke puts up an address.
  if (!depositor.isComputeAndInvoke) return { kind: "none" };

  if (depositor.address !== normalizeFelt(anonymizerAddress)) {
    return { kind: "unknownDelegate" };
  }

  const shadowAccount = shadowAccountOfPoolCall(poolCall, anonymizerAddress);
  return shadowAccount === null
    ? { kind: "undeterminedShadowAccount" }
    : { kind: "one", address: shadowAccount };
}

function interactionArguments(input: {
  compute_additional_data: bigint[];
  invoke_additional_data: bigint[];
}): ShadowAccountInteraction | null {
  try {
    if (input.compute_additional_data.length !== COMPUTE_ARGUMENT_TYPES.length) {
      return null;
    }
    const [dappName, nonce] = anonymizerDecoder.decodeParameters(
      COMPUTE_ARGUMENT_TYPES,
      input.compute_additional_data.map(num.toHex)
    ) as bigint[];
    // `calls` is unread: which shadow account acts is what decides the address to screen, not what
    // it does.
    const [, openNotes] = anonymizerDecoder.decodeParameters(
      INVOKE_ARGUMENT_TYPES,
      input.invoke_additional_data.map(num.toHex)
    ) as [unknown, unknown[]];
    return openNotes.length === 0 ? null : { dappName, nonce };
  } catch {
    return null;
  }
}

/**
 * The types of `name`'s arguments after its first one, read from the committed anonymizer ABI. A
 * Cairo-side rename of a parameter's type therefore reaches this decode through the ABI generated
 * from it.
 */
function anonymizerArgumentTypes(name: string): string[] {
  const method = anonymizerDecoder.parser.getMethod(name);
  if (method === undefined) {
    throw new Error(`${name} is missing from the anonymizer ABI`);
  }
  return method.inputs.slice(1).map((input) => input.type);
}

/**
 * Refuses a policy the switch above does not handle, and fails closed if one reaches it at runtime.
 * The `never` parameter is the point: `scripts/check_screening_policies.py` keeps
 * {@link OpenNoteScreeningPolicy} tracking the Cairo enum, so a new variant fails to compile here
 * instead of falling through and screening nobody.
 */
function unscreenableUnderUnhandledPolicy(_policy: never): ScreeningSubject {
  return { kind: "unreadablePolicy" };
}
