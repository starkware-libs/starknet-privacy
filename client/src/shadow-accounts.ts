import type { TypedContractV2 } from "starknet";
import { ShadowAccountAnonymizerABI } from "@starkware-libs/starknet-privacy-sdk";
import type { AddressRange, ShadowAccountInfo } from "./interfaces.js";

/** The anonymizer contract typed against its generated ABI, as the client caches it. */
export type ShadowAccountAnonymizerContract = TypedContractV2<typeof ShadowAccountAnonymizerABI>;

/**
 * Upper bound (mirrors the Cairo `MAX_SCAN_RANGE`) on the nonce span a single `get_shadow_accounts`
 * view call may resolve; larger ranges are paginated across successive calls.
 */
const MAX_SCAN_RANGE = 1024;

/** Default upper bound (exclusive) for {@link AddressRange.end} when the caller gives none. */
export const DEFAULT_ADDRESS_RANGE_END = 100;

export interface ResolveShadowAccountsParams {
  /** The anonymizer contract (typed, created once by the client). */
  anonymizer: ShadowAccountAnonymizerContract;
  /** `hash(identity_key, dapp_name)`, from the identity source. */
  partialCommitment: bigint;
  range: AddressRange;
}

/**
 * Resolves the shadow accounts under `partialCommitment` via the anonymizer's `get_shadow_accounts` view
 * for `[start, end)`, paginated across `MAX_SCAN_RANGE` windows.
 *
 * The address is not recomputed client-side: the view returns the address stored on chain,
 * for deployed accounts, and calculated addresses for undeployed ones.
 *
 * With `untilUndeployed: true` the view stops at the first undeployed nonce and returns the
 * contiguous deployed prefix; a short window is the signal it stopped, so pagination ends there.
 */
export async function resolveShadowAccounts(
  params: ResolveShadowAccountsParams
): Promise<ShadowAccountInfo[]> {
  const { anonymizer, partialCommitment, range } = params;
  const start = range.start ?? 0;
  const end = range.end ?? start + DEFAULT_ADDRESS_RANGE_END;
  const untilUndeployed = range.untilUndeployed ?? false;

  const infos: ShadowAccountInfo[] = [];
  for (let from = start; from < end; from += MAX_SCAN_RANGE) {
    const to = Math.min(from + MAX_SCAN_RANGE, end);
    // abi-wan statically types the ContractAddress field as `string`, but the runtime decoder returns
    // a bigint (pinned by the client integration test), which is the {@link ShadowAccountInfo} shape.
    const window = (await anonymizer.get_shadow_accounts(
      partialCommitment,
      from,
      to,
      untilUndeployed
    )) as unknown as ShadowAccountInfo[];
    infos.push(...window);
    if (untilUndeployed && window.length < to - from) break;
  }
  return infos;
}
