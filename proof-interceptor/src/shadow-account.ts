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

/**
 * A shadow account interaction: an invoke the pool runs on the anonymizer that
 * settles at least one open note, and so funds a deposit.
 *
 * The fields are the anonymizer's `privacy_compute` arguments. Together with
 * the identity key the pool derives from the user, they determine the identity
 * commitment, and through it the one shadow account holding the dapp's funds
 * until they reach an open note. That account is the address to screen.
 */
export interface ShadowAccountInteraction {
  dappName: bigint;
  nonce: bigint;
}

/**
 * The address of the shadow account a pool call's interaction runs through, or `null` when the call
 * runs none, or when a felt the derivation needs does not parse. It is the address to screen for the
 * open notes that interaction funds.
 *
 * The derivation is local, using the SDK's formulas, so it resolves even for an account that is not
 * deployed yet. The anonymizer salts the deploy by the identity commitment and cements
 * `PRIMER_CLASS_HASH`, which keeps the address independent of chain state, and a deployed account
 * sits at the same address.
 *
 * `poolCall.viewingKey` is a secret and stays inside this derivation.
 */
export function getShadowAccountAddress(
  poolCall: PoolCallActions,
  anonymizerAddress: string
): string | null {
  if (poolCall.viewingKey === null) return null;
  const interaction = getShadowAccountInteraction(
    poolCall.actions,
    anonymizerAddress
  );
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
 * The shadow account interaction among `actions`, or `null` when they run
 * none: no `ComputeAndInvoke` targets `anonymizerAddress`, the one that does
 * settles no open note (nothing is deposited, so nobody is screened), or its
 * data does not decode.
 *
 * Undecodable data counts as no interaction rather than as an error, since the
 * pool cannot execute it either and the transaction reverts on its own.
 *
 * The pool accepts at most one invoke-phase action per transaction, so a second
 * `ComputeAndInvoke` makes a transaction the pool rejects whatever this returns.
 * The first one wins here.
 */
export function getShadowAccountInteraction(
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
    if (
      normalizeFelt(num.toHex(input.contract_address)) !==
      normalizeFelt(anonymizerAddress)
    ) {
      continue;
    }
    return shadowAccountInteraction(input);
  }
  return null;
}

function shadowAccountInteraction(input: {
  compute_additional_data: bigint[];
  invoke_additional_data: bigint[];
}): ShadowAccountInteraction | null {
  try {
    if (
      input.compute_additional_data.length !== COMPUTE_ARGUMENT_TYPES.length
    ) {
      return null;
    }
    const [dappName, nonce] = anonymizerDecoder.decodeParameters(
      COMPUTE_ARGUMENT_TYPES,
      input.compute_additional_data.map(num.toHex)
    ) as bigint[];
    // `calls` is unread: which shadow account acts is what decides the address
    // to screen, not what it does.
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
