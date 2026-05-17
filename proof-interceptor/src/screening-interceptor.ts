// src/screening-interceptor.ts
import { createHmac } from "node:crypto";
import { CallData } from "starknet";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import type {
  InterceptorHealth,
  TransactionInterceptor,
  Verdict,
} from "./interceptor.js";
import type { ProveTxnV3 } from "./types.js";
import {
  screeningResults,
  screeningRetries,
  screeningDuration,
} from "./metrics.js";

export interface ScreeningConfig {
  ellipticProxyUrl: string;
  partnerName: string;
  partnerSecret: string;
  timeoutMs: number;
  failOpen: boolean;
  maxRetries: number;
  totalTimeoutMs: number;
  poolAddress: string;
  // When true, transactions that are not a single direct INVOKE call to
  // `poolAddress` are blocked outright. When false (default), such transactions
  // bypass screening and are allowed through.
  blockNonPoolTx: boolean;
  // Maximum duration the upstream may stay unreachable before /health reports
  // 503 (only when `failOpen` is false — when fail-open is on, an unreachable
  // upstream is operationally tolerated, so health stays green).
  healthMaxUnavailableMs: number;
}

const ACTIONS_TYPE =
  "core::array::Span::<privacy::actions::ClientAction>" as const;

const callDataDecoder = new CallData(PrivacyPoolABI);

/**
 * Returns true iff the transaction is a single-call INVOKE whose target
 * contract matches `poolAddress`.
 *
 * Expected calldata layout for a single-call INVOKE:
 *   [0] call_count          — must normalize to "0x1"
 *   [1] contract_address    — must match `poolAddress`
 *   [2] selector             — entrypoint selector (not checked here)
 *   [3] inner_calldata_len   — length of inner calldata
 *   [4..] inner calldata
 *
 * Multi-call batches (call_count !== 1) are not considered pool
 * transactions even if one of the inner calls targets the pool, because
 * single-call shape is required for the screening logic to extract the
 * deposit action and user address.
 *
 * All hex felts are normalized before comparison so attackers can't bypass
 * the check with variants like "0X1", "0x01", "0x001", or mixed-case digits.
 */
export function isSinglePoolCall(
  transaction: ProveTxnV3,
  poolAddress: string
): boolean {
  const calldata = transaction.calldata;
  if (calldata.length < 7 || normalizeFelt(calldata[0]) !== "0x1") return false;
  return normalizeFelt(calldata[1]) === normalizeFelt(poolAddress);
}

/**
 * Extracts addresses that need screening from a privacy pool transaction,
 * but only if the transaction is a single direct call to the pool and
 * contains a Deposit action. The inner calldata is decoded using the
 * contract ABI from the SDK.
 *
 * Returns `[]` for non-pool transactions and for pool transactions that
 * carry no Deposit action (e.g., Withdraw-only). Whether non-pool
 * transactions are then allowed through or blocked is decided by the
 * caller via `ScreeningConfig.blockNonPoolTx`.
 */
export function getScreenedAddresses(
  transaction: ProveTxnV3,
  poolAddress: string
): string[] {
  if (!isSinglePoolCall(transaction, poolAddress)) return [];

  const calldata = transaction.calldata;
  const innerCalldataLength = parseInt(calldata[3], 16);
  if (Number.isNaN(innerCalldataLength) || innerCalldataLength < 3) return [];

  const innerCalldata = calldata.slice(4, 4 + innerCalldataLength);

  // innerCalldata[0] = user_addr, [1] = user_private_key, [2..] = actions span
  const actionsCalldata = innerCalldata.slice(2);
  if (!hasDepositAction(actionsCalldata)) return [];

  return [normalizeFelt(innerCalldata[0])];
}

/**
 * Decodes serialized client actions using the contract ABI and checks for Deposit.
 * Returns false if the calldata is malformed (fail-open: don't screen garbage).
 */
function hasDepositAction(actionsCalldata: string[]): boolean {
  try {
    const decoded = callDataDecoder.decodeParameters(
      ACTIONS_TYPE,
      actionsCalldata
    ) as Array<{ activeVariant: () => string }>;

    return decoded.some((action) => action.activeVariant() === "Deposit");
  } catch {
    return false;
  }
}

/**
 * Canonicalizes a hex felt252 string for equality comparison. Lowercases the
 * input (so "0X" / "0x" prefixes and "ABC" / "abc" digits all normalize the
 * same), strips the optional "0x" prefix, removes leading zeros, then
 * re-attaches "0x". Returns "0x0" for the zero value.
 */
function normalizeFelt(value: string): string {
  const lower = value.toLowerCase();
  const hex = lower.startsWith("0x") ? lower.slice(2) : lower;
  return "0x" + (hex.replace(/^0+/, "") || "0");
}

type ScreenResult = "allowed" | "blocked" | "unavailable";

export class ScreeningInterceptor implements TransactionInterceptor {
  readonly name = "screening";

  // Reachability tracking for /health. `null` means the upstream is healthy
  // (either no failures yet, or the most recent call succeeded). When a call
  // fails and this field is null, it's set to `Date.now()`. The /health
  // endpoint flips to 503 once the window exceeds `healthMaxUnavailableMs`.
  // Only relevant when `failOpen` is false — see `health()`.
  private consecutiveFailureStartAt: number | null = null;

  constructor(private readonly config: ScreeningConfig) {}

  health(): InterceptorHealth {
    // Fail-open means the operator has accepted that we ship transactions
    // through even when screening is down, so unreachability does not make
    // the *service* unhealthy.
    if (this.config.failOpen) return { healthy: true };
    if (this.consecutiveFailureStartAt === null) return { healthy: true };
    const unavailableMs = Date.now() - this.consecutiveFailureStartAt;
    if (unavailableMs > this.config.healthMaxUnavailableMs) {
      return { healthy: false, reason: "screening_unreachable" };
    }
    return { healthy: true };
  }

  async intercept(transaction: ProveTxnV3): Promise<Verdict> {
    if (!isSinglePoolCall(transaction, this.config.poolAddress)) {
      const action = this.config.blockNonPoolTx ? "block" : "allow";
      console.log(
        JSON.stringify({
          screening: "non_pool_tx",
          action,
          blockNonPoolTx: this.config.blockNonPoolTx,
        })
      );
      if (action === "block") {
        return {
          action: "block",
          reason: "transaction is not a direct call to the privacy pool",
        };
      }
      return { action: "allow" };
    }

    const addresses = getScreenedAddresses(
      transaction,
      this.config.poolAddress
    );
    if (addresses.length === 0) return { action: "allow" };

    for (const address of addresses) {
      const result = await this.screenAddress(address);
      if (result === "blocked") {
        return {
          action: "block",
          reason: `address screening: ${address} blocked`,
        };
      }
      if (result === "unavailable") {
        return {
          action: "block",
          reason: `screening unavailable for ${address}`,
        };
      }
    }

    return { action: "allow" };
  }

  private async screenAddress(address: string): Promise<ScreenResult> {
    let lastError: Error | null = null;
    let finalAttempt = 0;
    const deadline = Date.now() + this.config.totalTimeoutMs;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      finalAttempt = attempt;
      if (attempt > 0) {
        screeningRetries.inc();
        const backoffMs = exponentialBackoff(attempt);
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await sleep(Math.min(backoffMs, remainingMs));
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      try {
        const perCallTimeout = Math.min(this.config.timeoutMs, remainingMs);
        const callStart = Date.now();
        const blocked = await this.callEllipticProxy(address, perCallTimeout);
        const result: ScreenResult = blocked ? "blocked" : "allowed";
        const screeningLatencyMs = Date.now() - callStart;
        screeningResults.inc({ result });
        screeningDuration.observe({ result }, screeningLatencyMs / 1000);
        // A successful call clears the unreachability window.
        this.consecutiveFailureStartAt = null;
        console.log(
          JSON.stringify({
            screening: "complete",
            result,
            attempts: attempt + 1,
            screeningLatencyMs,
          })
        );
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Start (or extend) the unreachability window for /health.
        if (this.consecutiveFailureStartAt === null) {
          this.consecutiveFailureStartAt = Date.now();
        }
      }
    }

    console.error(
      JSON.stringify({
        error: "screening_failed",
        message: lastError?.message,
        failOpen: this.config.failOpen,
        attempts: finalAttempt + 1,
      })
    );

    // fail-closed by default: if we can't screen, block the transaction
    const failResult = this.config.failOpen ? "allowed" : "unavailable";
    screeningResults.inc({ result: failResult });
    return failResult;
  }

  private async callEllipticProxy(
    address: string,
    timeoutMs: number
  ): Promise<boolean> {
    const body = JSON.stringify({ address });
    const path = "/screen";
    const timestamp = Date.now().toString();
    const signature = computeHmacSignature(
      this.config.partnerSecret,
      timestamp,
      "POST",
      path,
      body
    );

    const response = await fetch(this.config.ellipticProxyUrl + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-access-key": this.config.partnerName,
        "x-access-sign": signature,
        "x-access-timestamp": timestamp,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`elliptic-proxy returned ${response.status}`);
    }

    const result: unknown = await response.json();
    if (
      typeof result !== "object" ||
      result === null ||
      typeof (result as Record<string, unknown>).blocked !== "boolean"
    ) {
      throw new Error("elliptic-proxy returned invalid response payload");
    }
    return (result as Record<string, unknown>).blocked as boolean;
  }
}

function computeHmacSignature(
  secretBase64: string,
  timestamp: string,
  method: string,
  path: string,
  body: string
): string {
  const hmac = createHmac("sha256", Buffer.from(secretBase64, "base64"));
  hmac.update(timestamp);
  hmac.update(method);
  hmac.update(path.toLowerCase());
  hmac.update(body);
  return hmac.digest("base64");
}

function exponentialBackoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 5000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
