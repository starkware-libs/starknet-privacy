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
 * commitment.
 *
 * The anonymizer deploys with `deploy_from_zero: false` and no constructor arguments, so the
 * address derives from (commitment, `PRIMER_CLASS_HASH`, empty calldata, the anonymizer). This
 * assumes the primer pattern: an anonymizer deployed *before* the primer pattern existed deploys
 * the shadow account class directly, so this returns the wrong address for it — the constant is
 * unconditional, there is no on-chain check that `anonymizerAddress` actually uses it. Callers
 * that cannot assume every anonymizer post-dates the primer pattern should use
 * {@link shadowAccountAddressOnChain} instead, which reads the deploy class from the anonymizer
 * itself. Callers that only need the address of an *already deployed* account can read it from the
 * anonymizer's `get_shadow_account` view directly.
 */
export function shadowAccountAddress(commitment: bigint, anonymizerAddress: bigint): bigint {
  return toBigInt(
    starknetHash.calculateContractAddressFromHash(
      commitment,
      PRIMER_CLASS_HASH,
      [],
      anonymizerAddress
    )
  );
}

/**
 * Same as {@link shadowAccountAddress}, but reads the deploy class straight from the anonymizer
 * instead of assuming {@link PRIMER_CLASS_HASH}, so it is correct for anonymizers deployed before
 * the primer pattern too.
 *
 * Prefers the anonymizer's `get_primer_class_hash` view where it exists; anonymizers that predate
 * the primer pattern have no such entrypoint (the call reverts with `ENTRYPOINT_NOT_FOUND`) and
 * deploy the shadow account class directly, so this falls back to `get_shadow_account_class_hash`
 * for them. Costs a round trip to `provider`; callers deriving many addresses for the same
 * anonymizer should cache the resolved class hash rather than call this per commitment.
 */
export async function shadowAccountAddressOnChain(
  commitment: bigint,
  anonymizerAddress: bigint,
  provider: ProviderInterface
): Promise<bigint> {
  const classHash = await deployClassHash(anonymizerAddress, provider);
  return toBigInt(
    starknetHash.calculateContractAddressFromHash(commitment, classHash, [], anonymizerAddress)
  );
}

/**
 * The class hash `anonymizerAddress` deploys shadow accounts from, read from the anonymizer
 * itself: `get_primer_class_hash` where it exists, otherwise `get_shadow_account_class_hash` for a
 * pre-primer anonymizer that deploys the shadow account class directly.
 */
async function deployClassHash(
  anonymizerAddress: bigint,
  provider: ProviderInterface
): Promise<bigint> {
  const contractAddress = toHex(anonymizerAddress);
  try {
    const [classHash] = await provider.callContract({
      contractAddress,
      entrypoint: "get_primer_class_hash",
      calldata: [],
    });
    return toBigInt(classHash);
  } catch {
    // Pre-primer anonymizers expose no `get_primer_class_hash` entrypoint at all; they deploy the
    // shadow account class directly, so that class hash is the correct deploy class for them.
    const [classHash] = await provider.callContract({
      contractAddress,
      entrypoint: "get_shadow_account_class_hash",
      calldata: [],
    });
    return toBigInt(classHash);
  }
}
