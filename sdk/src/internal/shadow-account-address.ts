import type { ProviderInterface } from "starknet";
import { hash as starknetHash } from "starknet";

import { hash as poseidonHash, toBigInt, toHex } from "../utils/index.js";
import { compute_identity_key } from "../utils/hashes.js";

/**
 * Class hash of the `Primer` contract every shadow account is deployed from, before the anonymizer
 * replaces its class with the shadow account's. Mirrors `PRIMER_CLASS_HASH` in
 * `packages/shadow_account_anonymizer/src/shadow_account_anonymizer.cairo`, cemented there so a
 * shadow account's address does not move when the shadow account class changes.
 *
 * A mismatch with the Cairo constant makes every address below wrong, so CI asserts the two agree.
 */
export const PRIMER_CLASS_HASH =
  0x00123e6bc1c14ae9934e933d3f64916a6116dd6b036a922b2b1f0815e0d1d300n;

/**
 * The user+dapp half of a shadow account's identity commitment,
 * `hash(compute_identity_key(user, viewingKey, anonymizer), dappName)`.
 *
 * Mirrors `partial_commitment` in the anonymizer. `dappName` is a felt, so encode a short string
 * before calling.
 */
export function shadowAccountPartialCommitment(
  user: bigint,
  viewingKey: bigint,
  anonymizerAddress: bigint,
  dappName: bigint
): bigint {
  return poseidonHash(compute_identity_key(user, viewingKey, anonymizerAddress), dappName);
}

/**
 * The full identity commitment of one shadow account, `hash(partialCommitment, nonce)`. Mirrors
 * `commitment_from_partial` in the anonymizer.
 */
export function shadowAccountCommitment(partialCommitment: bigint, nonce: bigint): bigint {
  return poseidonHash(partialCommitment, nonce);
}

/**
 * The address the anonymizer deploys the shadow account of `commitment` to, salted by that
 * commitment, assuming the primer pattern.
 *
 * The anonymizer deploys with `deploy_from_zero: false` and no constructor arguments, so the
 * address derives from (commitment, `PRIMER_CLASS_HASH`, empty calldata, the anonymizer). This is
 * correct for a current-generation anonymizer, but an anonymizer deployed *before* the primer
 * pattern existed deploys the shadow account class directly, so this returns the wrong address for
 * it. There is no on-chain way to tell the two apart ahead of deployment: `PRIMER_CLASS_HASH` is a
 * Cairo constant, not exposed by any view, so nothing on `anonymizerAddress` itself says whether it
 * uses the primer pattern.
 *
 * For an *already deployed* account, read the anonymizer's `get_shadow_account` view instead, or
 * use {@link shadowAccountAddressOnChain}, which does that lookup and falls back to this formula
 * only when nothing is deployed for `commitment` yet. For an anonymizer known out of band to
 * predate the primer pattern, pass its shadow account class hash (its `get_shadow_account_class_hash`
 * view) to {@link shadowAccountAddressFromClassHash} instead of calling this function.
 */
export function shadowAccountAddress(commitment: bigint, anonymizerAddress: bigint): bigint {
  return shadowAccountAddressFromClassHash(commitment, PRIMER_CLASS_HASH, anonymizerAddress);
}

/**
 * The address a shadow account of `commitment` deploys to from `classHash`, salted by that
 * commitment: the same derivation {@link shadowAccountAddress} uses with `PRIMER_CLASS_HASH`,
 * generalized to an explicit class hash.
 *
 * For an anonymizer known out of band to predate the primer pattern (see
 * {@link shadowAccountAddress}), pass its shadow account class hash here directly rather than
 * relying on the primer formula, which is wrong for that generation. There is no on-chain
 * discriminator to make this choice automatically; the caller must know which generation
 * `anonymizerAddress` is.
 */
export function shadowAccountAddressFromClassHash(
  commitment: bigint,
  classHash: bigint,
  anonymizerAddress: bigint
): bigint {
  return toBigInt(
    starknetHash.calculateContractAddressFromHash(commitment, classHash, [], anonymizerAddress)
  );
}

/**
 * The address the anonymizer deploys the shadow account of `commitment` to, resolved against the
 * chain rather than assumed off-chain.
 *
 * Looks up `commitment` in the anonymizer's `get_shadow_account` registry first. If a shadow
 * account is already deployed for it, the registry's stored address is authoritative regardless of
 * which class the anonymizer deploys from — a pre-primer anonymizer's registry is exactly as
 * trustworthy as a primer-pattern one's, so this needs no class hash at all in that case.
 *
 * If nothing is deployed yet, there is no on-chain way to tell which class this anonymizer *will*
 * deploy from: as {@link shadowAccountAddress} explains, the primer pattern's class hash is a Cairo
 * constant with no corresponding view, so a pre-primer anonymizer is indistinguishable on-chain from
 * a primer-pattern one before something is actually deployed. This falls back to
 * {@link shadowAccountAddress}'s primer formula in that case — correct for a current-generation
 * anonymizer, but a guess that is wrong for one that predates the primer pattern. Do not fund a
 * predicted, not-yet-deployed address on an anonymizer whose generation you have not verified out
 * of band; a caller who knows they are targeting an older anonymizer should read its
 * `get_shadow_account_class_hash` and call {@link shadowAccountAddressFromClassHash} explicitly
 * instead of relying on this fallback.
 */
export async function shadowAccountAddressOnChain(
  commitment: bigint,
  anonymizerAddress: bigint,
  provider: ProviderInterface
): Promise<bigint> {
  const [deployed] = await provider.callContract({
    contractAddress: toHex(anonymizerAddress),
    entrypoint: "get_shadow_account",
    calldata: [toHex(commitment)],
  });
  const deployedAddress = toBigInt(deployed);
  if (deployedAddress !== 0n) {
    return deployedAddress;
  }
  return shadowAccountAddress(commitment, anonymizerAddress);
}
