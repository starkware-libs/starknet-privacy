/**
 * Detection of a pool's screening capability from its on-chain interface.
 *
 * The screening-capable ("new") pool exposes a `screening_version` view; the
 * current pool does not. The SDK packs the screening attestation into
 * `apply_actions` calldata only against a screening-capable pool, so a single
 * SDK build talks to both pool versions (see `screeningCalldataSuffix`).
 *
 * Detection is deliberately strict: only an entrypoint-not-found revert proves
 * the current pool. Any other failure (network, node down, timeout, malformed
 * response) surfaces as {@link PoolCapabilityError} so the caller retries
 * rather than guessing a calldata arity that would revert on-chain.
 */

import type { RpcProvider } from "starknet";
import { PoolCapabilityError } from "./errors.js";

/** Whether the target pool expects the screening attestation in `apply_actions` calldata. */
export type PoolCapabilityMode = "screening" | "compatibility";

/** View selector probed to detect screening capability. */
const SCREENING_VERSION_SELECTOR = "screening_version";

/** Lowest `screening_version` that activates screening arity; 0 is reserved/unused. */
const MIN_SCREENING_VERSION = 1n;

/**
 * Resolve a pool's screening capability via a single `starknet_call` to its
 * `screening_version` view.
 *
 * - call returns a felt `>= 1` → `"screening"`
 * - call reverts with entrypoint-not-found → `"compatibility"` (current pool)
 * - call returns version `0` / an unparseable value → `"compatibility"`
 *   (the view exists but advertises no screening arity)
 * - any other failure → throws {@link PoolCapabilityError} (never assume compat)
 */
export async function resolvePoolScreeningCapability(
  rpcProvider: RpcProvider,
  poolAddress: string
): Promise<PoolCapabilityMode> {
  let callResult: string[];
  try {
    callResult = await rpcProvider.callContract({
      contractAddress: poolAddress,
      entrypoint: SCREENING_VERSION_SELECTOR,
      calldata: [],
    });
  } catch (error) {
    if (isEntrypointNotFoundError(error)) {
      return "compatibility";
    }
    throw new PoolCapabilityError(poolAddress, error);
  }
  return screeningVersionFromCallResult(callResult) >= MIN_SCREENING_VERSION
    ? "screening"
    : "compatibility";
}

/**
 * Match Starknet's entrypoint-not-found revert across node implementations,
 * which phrase it variously as `ENTRYPOINT_NOT_FOUND`, `Entry point ... not
 * found`, or `... not found in contract`. The error text is external input, so
 * normalize separators away and substring-match defensively rather than relying
 * on a structured error code that differs between RPC spec versions.
 */
export function isEntrypointNotFoundError(error: unknown): boolean {
  const normalized = errorText(error)
    .toUpperCase()
    .replace(/[\s_]+/g, "");
  return normalized.includes("ENTRYPOINTNOTFOUND") || normalized.includes("NOTFOUNDINCONTRACT");
}

/** Flatten an unknown thrown value (message plus any nested data fields) into searchable text. */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error == null) return "";
  // `message` is non-enumerable on Error, so capture it separately; a plain
  // stringify then picks up enumerable own props recursively (e.g. a nested
  // `data` field on a structured RPC error) without an allowlist that would
  // drop nested keys.
  const message = error instanceof Error ? error.message : "";
  let serialized = "";
  try {
    serialized = JSON.stringify(error);
  } catch {
    serialized = "";
  }
  return `${message} ${serialized}`;
}

/**
 * Parse the single felt252 returned by `screening_version`. A successful call
 * with an empty or unparseable payload is treated as version 0 (compatibility):
 * the entrypoint exists but advertises no screening arity. External input — never
 * throws.
 */
function screeningVersionFromCallResult(callResult: string[]): bigint {
  const versionFelt = callResult[0];
  if (versionFelt === undefined) return 0n;
  try {
    return BigInt(versionFelt);
  } catch {
    return 0n;
  }
}
