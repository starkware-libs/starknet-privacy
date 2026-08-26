// src/shadow-account.ts
import { CairoCustomEnum, CallData, num } from "starknet";
import {
  ShadowAccountAnonymizerABI,
  shadowAccountAddress,
  shadowAccountCommitment,
  shadowAccountPartialCommitment,
} from "@starkware-libs/starknet-privacy-sdk";
import {
  normalizeFelt,
  parseFelt,
  type PoolCallActions,
} from "./pool-transaction.js";

const anonymizerDecoder = new CallData(ShadowAccountAnonymizerABI);

/**
 * The parameters of `privacy_compute` and `privacy_invoke_with_computation` that
 * a `ComputeAndInvoke` action supplies, which is all but the leading one of
 * each. The pool prepends the identity key to the first, and to the second the
 * identity commitment `privacy_compute` returned.
 */
const COMPUTE_ARGUMENT_TYPES = anonymizerArgumentTypes("privacy_compute");
const INVOKE_ARGUMENT_TYPES = anonymizerArgumentTypes(
  "privacy_invoke_with_computation"
);

/** Why a pool call names no shadow account: the pool asks for none, or for one this cannot name. */
type UnresolvedShadowAccount =
  | { kind: "noOpenNotes" }
  | { kind: "undetermined" };

/**
 * A shadow account interaction: an invoke the pool runs on the anonymizer that
 * settles at least one open note, and so funds a deposit.
 *
 * The fields are the anonymizer's `privacy_compute` arguments. Together with
 * the identity key the pool derives from the user, they determine the identity
 * commitment, and through it the one shadow account holding the dapp's funds
 * until they reach an open note. That account is the address to screen.
 */
export type ShadowAccountInteraction =
  | { kind: "interaction"; dappName: bigint; nonce: bigint }
  | UnresolvedShadowAccount;

export type ShadowAccountResolution =
  | { kind: "address"; address: string }
  | UnresolvedShadowAccount;

/**
 * The address of the shadow account a pool call's interaction runs through — the address to screen
 * for the open notes that interaction funds — or why the call puts up none.
 *
 * The derivation is local, using the SDK's formulas, so it resolves even for an account that is not
 * deployed yet. The anonymizer salts the deploy by the identity commitment and cements
 * `PRIMER_CLASS_HASH`, which keeps the address independent of chain state, and a deployed account
 * sits at the same address.
 *
 * An invoke that settles nothing answers `noOpenNotes` regardless of the derivation.
 *
 * `poolCall.viewingKey` is a secret and stays inside this derivation.
 */
export function getShadowAccountAddress(
  poolCall: PoolCallActions,
  anonymizerAddress: string
): ShadowAccountResolution {
  const interaction = getShadowAccountInteraction(
    poolCall.actions,
    anonymizerAddress
  );
  if (interaction.kind !== "interaction") return interaction;
  if (poolCall.viewingKey === null) return { kind: "undetermined" };
  const userAddress = parseFelt(poolCall.userAddress);
  if (userAddress === null) return { kind: "undetermined" };

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
  return {
    kind: "address",
    address: normalizeFelt(
      num.toHex(shadowAccountAddress(commitment, anonymizer))
    ),
  };
}

/**
 * The shadow account interaction among `actions`, or why they run none.
 *
 * Undecodable data counts as `undetermined` rather than as an error, since the
 * pool cannot execute it either and the transaction reverts on its own.
 *
 * The pool accepts at most one invoke-phase action per transaction, so a second
 * `ComputeAndInvoke` makes a transaction the pool rejects whatever this returns.
 * The first one wins here.
 */
export function getShadowAccountInteraction(
  actions: CairoCustomEnum[],
  anonymizerAddress: string
): ShadowAccountInteraction {
  for (const action of actions) {
    if (action.activeVariant() !== "ComputeAndInvoke") continue;
    const input = action.unwrap() as {
      contract_address: bigint;
      compute_additional_data: bigint[];
      invoke_additional_data: bigint[];
    };
    if (
      normalizeFelt(num.toHex(input.contract_address)) !==
      normalizeFelt(anonymizerAddress)
    ) {
      continue;
    }
    return shadowAccountInteraction(input);
  }
  return { kind: "undetermined" };
}

function shadowAccountInteraction(input: {
  compute_additional_data: bigint[];
  invoke_additional_data: bigint[];
}): ShadowAccountInteraction {
  const openNotes = settledOpenNotes(input.invoke_additional_data);
  if (openNotes === null) return { kind: "undetermined" };
  if (openNotes.length === 0) return { kind: "noOpenNotes" };

  if (input.compute_additional_data.length !== COMPUTE_ARGUMENT_TYPES.length) {
    return { kind: "undetermined" };
  }
  try {
    const [dappName, nonce] = anonymizerDecoder.decodeParameters(
      COMPUTE_ARGUMENT_TYPES,
      input.compute_additional_data.map(num.toHex)
    ) as bigint[];
    return { kind: "interaction", dappName, nonce };
  } catch {
    return { kind: "undetermined" };
  }
}

/** The open notes an invoke settles, or `null` when its data does not decode. */
function settledOpenNotes(invokeData: bigint[]): unknown[] | null {
  try {
    // `calls` is unread: which shadow account acts is what decides the address
    // to screen, not what it does.
    const [, openNotes] = anonymizerDecoder.decodeParameters(
      INVOKE_ARGUMENT_TYPES,
      invokeData.map(num.toHex)
    ) as [unknown, unknown[]];
    return openNotes;
  } catch {
    return null;
  }
}

/**
 * The types of `name`'s arguments after its first one, read from the committed
 * anonymizer ABI. A Cairo-side rename of a parameter's type therefore reaches
 * this decode through the ABI generated from it.
 */
function anonymizerArgumentTypes(name: string): string[] {
  const method = anonymizerDecoder.parser.getMethod(name);
  if (method === undefined) {
    throw new Error(`${name} is missing from the anonymizer ABI`);
  }
  return method.inputs.slice(1).map((input) => input.type);
}
