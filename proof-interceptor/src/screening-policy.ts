// src/screening-policy.ts
import { LRUCache } from "lru-cache";
import { CairoCustomEnum, CallData, RpcProvider } from "starknet";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import { normalizeFelt } from "./pool-transaction.js";
import { screeningPolicyReads } from "./metrics.js";

/**
 * The pool answers with a variant index, so this must match the Cairo enum in name and order.
 * `scripts/check_screening_policies.py` fails a pull request where the two disagree.
 */
export type OpenNoteScreeningPolicy = "Required" | "Exempt" | "Delegated";

export const MAX_CACHED_POLICIES = 1024;

export const DEFAULT_POLICY_TTL_MS = 15 * 60 * 1000;

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
 * interceptor without a paired config update.
 */
export class OpenNoteScreeningPolicyClient {
  private readonly cachedPolicies: LRUCache<string, OpenNoteScreeningPolicy>;
  private readonly provider: RpcProvider;

  constructor(private readonly config: PolicyClientConfig) {
    const timeoutMs = config.timeoutMs ?? DEFAULT_POLICY_TIMEOUT_MS;
    this.cachedPolicies = new LRUCache({
      max: MAX_CACHED_POLICIES,
      ttl: config.ttlMs ?? DEFAULT_POLICY_TTL_MS,
      // Age entries by the wall clock, so the TTL is a window of real time.
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
   * The pool's open-note screening policy for `depositor`, from the cache or a fresh read, or `null`
   * when the read fails, times out or answers with something that is not a policy. A failed read is
   * never cached, and an expired entry is never served.
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
 * The pool answers with one felt, the variant index of its policy enum, decoded through the
 * committed ABI.
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
