/**
 * Pool calldata-mode selection by deployed class hash.
 *
 * The mode is a lookup of the pool's class hash (the first felt of the prove
 * response's payload) against the pinned pre-screening pools — no RPC.
 * Unpinned class hashes are treated as screening-capable, so an upgraded pool
 * activates without an SDK release; source-built test pools pass an explicit
 * `poolMode` override instead.
 */

/** Whether the target pool expects the screening attestation in `apply_actions` calldata. */
export type PoolCapabilityMode = "screening" | "compatibility";

/** Class hashes of the deployed pre-screening pools. */
export const COMPATIBILITY_POOL_CLASS_HASHES: readonly bigint[] = [
  // SN_SEPOLIA
  0x715b22abfb60815623f4127ba64bd2f93613d8a5c1e519841eaab444659d2afn,
  // SN_MAIN
  0x30b8c540cf04d8ef0f4db2a9098d9cc0e35e83af1cb3325f5a4f40144b4b30bn,
];

/**
 * Select the calldata mode by pool class hash. `undefined` or an unparseable
 * felt selects compatibility — such a proof is unusable on-chain anyway, so
 * no attestation suffix is invented for it.
 */
export function poolModeForClassHash(classHashFelt: string | undefined): PoolCapabilityMode {
  if (classHashFelt === undefined) return "compatibility";
  let classHashValue: bigint;
  try {
    classHashValue = BigInt(classHashFelt);
  } catch {
    return "compatibility";
  }
  // Canonical-felt comparison, so zero-padded and stripped forms match.
  return COMPATIBILITY_POOL_CLASS_HASHES.some((pinnedHash) => pinnedHash === classHashValue)
    ? "compatibility"
    : "screening";
}
