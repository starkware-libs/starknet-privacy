// src/screened-address.ts
import {
  screeningSubjectOf,
  type ScreeningSubject,
} from "@starkware-libs/starknet-privacy-sdk";
import { decodeClientActions } from "./pool-transaction.js";
import type { ProveTxnV3 } from "./types.js";
import type { OpenNoteScreeningPolicyClient } from "./screening-policy.js";

type PolicyReader = Pick<OpenNoteScreeningPolicyClient, "getPolicy">;

export interface ScreenedAddressConfig {
  poolAddress: string;
  anonymizerAddress: string;
}

export type ScreenedAddress = ScreeningSubject;

/**
 * The opaque code a subject this service cannot derive is logged under. `conflict` and
 * `unreadablePolicy` are absent on purpose: the first is the transaction's own shape and the second
 * is already logged, with its cause, by the read that failed.
 */
const UNDERIVABLE_SUBJECT_LOGS: Record<
  Extract<
    ScreenedAddress["kind"],
    "unknownDelegate" | "undeterminedShadowAccount"
  >,
  string
> = {
  unknownDelegate: "unknown_delegated_depositor",
  undeterminedShadowAccount: "shadow_account_undetermined",
};

/**
 * The address a prove request must be screened for.
 *
 * Screening an address the pool did not ask for is not a harmless extra: it rejects an attestation
 * it has no subject for with `UNEXPECTED_SCREENING`. The rule deciding that address is the SDK's
 * {@link screeningSubjectOf}, shared with the mock proving provider the devnet suites run against,
 * so the two cannot drift apart. What stays here is this service's own: decoding the pool call out
 * of a prove request, reading the policy over RPC, and logging a refusal as an opaque code.
 */
export async function getScreenedAddress(
  transaction: ProveTxnV3,
  config: ScreenedAddressConfig,
  policyReader: PolicyReader
): Promise<ScreenedAddress> {
  // Calldata the pool cannot parse reverts on its own, so nothing in it needs screening.
  const poolCall = decodeClientActions(transaction, config.poolAddress);
  if (poolCall === null) return { kind: "none" };

  const subject = await screeningSubjectOf(
    poolCall,
    (depositor) => policyReader.getPolicy(depositor),
    { anonymizerAddress: config.anonymizerAddress }
  );

  if (
    subject.kind === "unknownDelegate" ||
    subject.kind === "undeterminedShadowAccount"
  ) {
    console.error(
      JSON.stringify({ error: UNDERIVABLE_SUBJECT_LOGS[subject.kind] })
    );
  }
  return subject;
}
