import type { TypedContractV2 } from "starknet";
import { SubAccountAnonymizerABI } from "@starkware-libs/starknet-privacy-sdk";
import type { AddressRange, SubAccountInfo } from "./interfaces.js";

/** The anonymizer contract typed against its generated ABI, as the client caches it. */
export type SubAccountAnonymizerContract = TypedContractV2<typeof SubAccountAnonymizerABI>;

/**
 * Upper bound (mirrors the Cairo `MAX_SCAN_RANGE`) on the nonce span a single `get_sub_accounts`
 * view call may resolve; larger ranges are paginated across successive calls.
 */
const MAX_SCAN_RANGE = 1024;

/** Default upper bound (exclusive) for {@link AddressRange.end} when the caller gives none. */
export const DEFAULT_ADDRESS_RANGE_END = 100;

export interface ResolveSubAccountsParams {
  /** The anonymizer contract (typed, created once by the client). */
  anonymizer: SubAccountAnonymizerContract;
  /** `hash(identity_key, dapp_name)`, from the identity source. */
  partialCommitment: bigint;
  range: AddressRange;
}

/**
 * Resolves the sub-accounts under `partialCommitment` via the anonymizer's `get_sub_accounts` view
 * for `[start, end)`, paginated across `MAX_SCAN_RANGE` windows.
 *
 * The address is deliberately not recomputed client-side: it depends on the sub-account class hash,
 * so a client-side derivation would stop matching accounts already deployed under a prior hash. The
 * view returns the address stored on chain, which is authoritative across a class-hash change.
 *
 * With `untilUndeployed: true` the view stops at the first undeployed nonce and returns the
 * contiguous deployed prefix; a short window is the signal it stopped, so pagination ends there.
 */
export async function resolveSubAccounts(
  params: ResolveSubAccountsParams
): Promise<SubAccountInfo[]> {
  const { anonymizer, partialCommitment, range } = params;
  const start = range.start ?? 0;
  const end = range.end ?? start + DEFAULT_ADDRESS_RANGE_END;
  const untilUndeployed = range.untilUndeployed ?? false;

  const infos: SubAccountInfo[] = [];
  for (let from = start; from < end; from += MAX_SCAN_RANGE) {
    const to = Math.min(from + MAX_SCAN_RANGE, end);
    // abi-wan statically types the ContractAddress field as `string`, but the runtime decoder returns
    // a bigint (pinned by the client integration test), which is the {@link SubAccountInfo} shape.
    const window = (await anonymizer.get_sub_accounts(
      partialCommitment,
      from,
      to,
      untilUndeployed
    )) as unknown as SubAccountInfo[];
    infos.push(...window);
    if (untilUndeployed && window.length < to - from) break;
  }
  return infos;
}
