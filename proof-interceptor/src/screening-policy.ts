// src/screening-policy.ts
import { LRUCache } from "lru-cache";
import { CairoCustomEnum, CallData, RpcProvider } from "starknet";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import { normalizeFelt } from "./pool-transaction.js";
import { screeningPolicyReads } from "./metrics.js";

/**
 * The pool's `OpenNoteScreeningPolicy` for a depositor that funds open notes through an invoke.
 * `Required` makes the depositor itself the address to screen, `Exempt` screens nobody, and
 * `Delegated` takes the addresses to screen from the depositor's own invoke return data.
 *
 * `Required` is the policy of every address the pool was never told about.
 *
 * The pool answers with a variant index, so this list has to match the Cairo enum in name and in
 * order. `scripts/check_screening_policies.py` fails a pull request where it, the Cairo enum and the
 * committed pool ABI disagree.
 */
export type OpenNoteScreeningPolicy = "Required" | "Exempt" | "Delegated";

/**
 * How many policies the cache holds. Its keys are invoke targets read out of prove requests, so a
 * caller picks them; the cap bounds how far a stream of transactions to distinct targets grows it.
 * Eviction is least-recently-used, so such a stream costs re-reads of itself rather than of the few
 * targets real deposits go through.
 */
export const MAX_CACHED_POLICIES = 1024;

/** How long a policy read from the pool is reused, so a governance change takes effect within it. */
export const DEFAULT_POLICY_TTL_MS = 60_000;

/**
 * The budget for one request to the RPC, connection included. A read is never retried, so one that
 * outlasts it resolves as unresolvable and its caller fails closed.
 */
export const DEFAULT_POLICY_TIMEOUT_MS = 10_000;

const POLICY_TYPE = "privacy::objects::OpenNoteScreeningPolicy";
const poolCallData = new CallData(PrivacyPoolABI);

export interface PolicyClientConfig {
  /** A Starknet JSON-RPC endpoint. The client calls one view on it and nothing else. */
  rpcUrl: string;
  poolAddress: string;
  /** Defaults to {@link DEFAULT_POLICY_TTL_MS}. */
  ttlMs?: number;
  /** Defaults to {@link DEFAULT_POLICY_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Reads open-note screening policies from the pool over RPC, so a governance change reaches the
 * interceptor without a paired config update. Each depositor's policy is cached for `ttlMs`, which
 * bounds how long the interceptor and the pool can disagree about one.
 */
export class OpenNoteScreeningPolicyClient {
  private readonly cachedPolicies: LRUCache<string, OpenNoteScreeningPolicy>;
  private readonly provider: RpcProvider;

  constructor(private readonly config: PolicyClientConfig) {
    const timeoutMs = config.timeoutMs ?? DEFAULT_POLICY_TIMEOUT_MS;
    this.cachedPolicies = new LRUCache({
      max: MAX_CACHED_POLICIES,
      ttl: config.ttlMs ?? DEFAULT_POLICY_TTL_MS,
      // A policy's freshness is a window of wall-clock time, so entries age by `Date.now()` read at
      // each use rather than by the library's process-monotonic default. A clock stepped backwards
      // can hold a policy past its window, which costs a failed transaction rather than an
      // unscreened deposit: the pool checks the policy itself and reverts on the mismatch.
      perf: { now: () => Date.now() },
    });
    this.provider = new RpcProvider({
      nodeUrl: config.rpcUrl,
      // The provider takes no timeout of its own, so every request it makes carries one from here.
      baseFetch: (url, init) =>
        fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    });
  }

  /**
   * The policy the pool applies to open-note deposits from `depositor`, or `null` when the read
   * cannot be resolved: the call fails, times out, or answers with something that is not one of the
   * pool's policies. A caller must fail closed on `null` instead of assuming a policy. An assumed
   * `Exempt` lets a deposit through unscreened, and an assumed `Required` mints an attestation the
   * pool rejects as unexpected.
   *
   * A failed read is never cached and an expired entry is never served, so a policy that has become
   * unreadable reads as unresolvable rather than as its last known value.
   */
  async getPolicy(depositor: string): Promise<OpenNoteScreeningPolicy | null> {
    const address = normalizeFelt(depositor);
    // `allowStale` is off by default, so an entry past its TTL reads as absent.
    const cached = this.cachedPolicies.get(address);
    if (cached !== undefined) return cached;

    const policy = await this.readPolicy(address);
    if (policy === null) return null;
    this.cachedPolicies.set(address, policy);
    return policy;
  }

  private async readPolicy(
    depositor: string
  ): Promise<OpenNoteScreeningPolicy | null> {
    try {
      const felts = await this.provider.callContract(
        {
          contractAddress: this.config.poolAddress,
          entrypoint: "get_open_note_screening_policy",
          calldata: [depositor],
        },
        // The policy has to come from a block the pool's own execution will see. A change is
        // visible here once it is in `latest`, and to a cached read one TTL after that.
        "latest"
      );
      const policy = parsePolicy(felts);
      if (policy === null) throw new Error("the pool returned no policy");
      screeningPolicyReads.inc({ result: policy });
      return policy;
    } catch (error) {
      // No address goes into the log, as on the rest of this path.
      console.error(
        JSON.stringify({
          error: "screening_policy_unavailable",
          message: error instanceof Error ? error.message : String(error),
        })
      );
      screeningPolicyReads.inc({ result: "unavailable" });
      return null;
    }
  }
}

/**
 * The policy `felts` carry, or `null` when they carry none. The pool answers with one felt, the
 * variant index of its policy enum, and the index comes from the committed pool ABI, so this decode
 * follows a Cairo-side reorder. A longer answer is not this view: the ABI decode would read the
 * first felt and drop the rest, which for a changed return type is a policy invented from garbage.
 */
function parsePolicy(felts: unknown): OpenNoteScreeningPolicy | null {
  if (!Array.isArray(felts) || felts.length !== 1) return null;
  if (typeof felts[0] !== "string") return null;

  try {
    const decoded = poolCallData.decodeParameters(
      POLICY_TYPE,
      felts as string[]
    ) as CairoCustomEnum;
    const variant = decoded.activeVariant();
    return isPolicy(variant) ? variant : null;
  } catch {
    // `decodeParameters` rejects a variant index the enum does not have.
    return null;
  }
}

function isPolicy(variant: string): variant is OpenNoteScreeningPolicy {
  return (
    variant === "Required" || variant === "Exempt" || variant === "Delegated"
  );
}
