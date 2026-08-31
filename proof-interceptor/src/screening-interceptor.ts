// src/screening-interceptor.ts
import { createHmac } from "node:crypto";
import type {
  ScreeningSignature,
  TransactionInterceptor,
  Verdict,
} from "./interceptor.js";
import { isSinglePoolCall } from "./pool-transaction.js";
import { OpenNoteScreeningPolicyClient } from "./screening-policy.js";
import { getScreenedAddress } from "./screened-address.js";
import type { ScreenedAddress } from "./screened-address.js";
import type { ProveTxnV3 } from "./types.js";
import {
  screeningResults,
  screeningRetries,
  screeningDuration,
  signaturesIssued,
} from "./metrics.js";

export interface ScreeningConfig {
  ellipticProxyUrl: string;
  partnerName: string;
  partnerSecret: string;
  timeoutMs: number;
  // NOTE: fail-open is honored only for the legacy verdict; the v2 signing path
  // is always fail-closed — a deposit without a signature cannot proceed, so a
  // signing failure blocks regardless of this flag.
  failOpen: boolean;
  maxRetries: number;
  totalTimeoutMs: number;
  poolAddress: string;
  rpcUrl: string;
  policyTtlMs: number;
  policyTimeoutMs: number;
  // When true, transactions that are not a single direct INVOKE call to
  // `poolAddress` are blocked outright. When false (default), such transactions
  // bypass screening and are allowed through.
  blockNonPoolTx: boolean;
}

// 0x-hex felt, at most 64 hex digits (the zero-padded address width).
const HEX_FELT = /^0x[0-9a-fA-F]{1,64}$/;

/**
 * The opaque code each unresolved screening subject blocks with: they reach the client as JSON-RPC
 * error `data`, so they must not reveal an address. Keying by the kinds makes a new one a compile
 * error rather than a kind that falls through to being screened.
 */
const UNRESOLVED_SUBJECT_REASONS: Record<
  Exclude<ScreenedAddress["kind"], "one" | "none">,
  string
> = {
  conflict: "multiple_screening_subjects",
  unreadablePolicy: "screening_policy_unavailable",
  undeterminedShadowAccount: "shadow_account_undetermined",
};

type SignOutcome =
  | { result: "allowed"; signature: ScreeningSignature }
  | { result: "blocked" }
  | { result: "unavailable" };

export class ScreeningInterceptor implements TransactionInterceptor {
  readonly name = "screening";

  private readonly policies: OpenNoteScreeningPolicyClient;

  constructor(private readonly config: ScreeningConfig) {
    this.policies = new OpenNoteScreeningPolicyClient({
      rpcUrl: config.rpcUrl,
      poolAddress: config.poolAddress,
      ttlMs: config.policyTtlMs,
      timeoutMs: config.policyTimeoutMs,
    });
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

    const screened = await getScreenedAddress(
      transaction,
      this.config,
      this.policies
    );
    if (screened.kind === "none") return { action: "allow" };
    if (screened.kind !== "one") {
      return {
        action: "block",
        reason: UNRESOLVED_SUBJECT_REASONS[screened.kind],
      };
    }

    // One address per transaction, screened and signed in one `/screen` call.
    const outcome = await this.screenAndSign(screened.address);
    if (outcome.result === "blocked") {
      return { action: "block", reason: "address_blocked" };
    }
    if (outcome.result === "unavailable") {
      return { action: "block", reason: "screening_unavailable" };
    }
    return { action: "allow", signature: outcome.signature };
  }

  private async screenAndSign(address: string): Promise<SignOutcome> {
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
        const signResult = await this.callScreenEndpoint(
          address,
          perCallTimeout
        );
        const result = signResult.verdict;
        const screeningLatencyMs = Date.now() - callStart;
        screeningResults.inc({ result });
        screeningDuration.observe({ result }, screeningLatencyMs / 1000);
        console.log(
          JSON.stringify({
            screening: "complete",
            result,
            attempts: attempt + 1,
            screeningLatencyMs,
          })
        );
        if (signResult.verdict === "allowed") {
          signaturesIssued.inc();
          return { result: "allowed", signature: signResult.signature };
        }
        return { result: "blocked" };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    console.error(
      JSON.stringify({
        error: "screening_failed",
        message: lastError?.message,
        attempts: finalAttempt + 1,
      })
    );

    // Fail-closed: a deposit with no signature cannot proceed on-chain, so a
    // signing failure always blocks — failOpen does not apply to the sign path.
    screeningResults.inc({ result: "unavailable" });
    return { result: "unavailable" };
  }

  private async callScreenEndpoint(
    address: string,
    timeoutMs: number
  ): Promise<
    | { verdict: "allowed"; signature: ScreeningSignature }
    | { verdict: "blocked" }
  > {
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

    // A non-2xx is a transient transport/upstream fault — throw so the caller
    // retries, then fails closed.
    if (!response.ok) {
      throw new Error(`elliptic-proxy /screen returned ${response.status}`);
    }

    const payload: unknown = await response.json();
    if (!isScreenResponse(payload)) {
      throw new Error("elliptic-proxy /screen returned invalid payload");
    }
    // blocked === true is a definitive sanctioned verdict (terminal, no retry);
    // the 200 status keeps it out of the retry path above.
    if (payload.blocked) {
      return { verdict: "blocked" };
    }
    // Every allowed /screen response must carry a signature; its
    // absence means the upstream signer is misconfigured. Throw rather than let
    // an unsigned deposit proceed — the caller fails closed after retries.
    if (!isScreeningSignature(payload.signature)) {
      throw new Error("elliptic-proxy /screen allowed without a signature");
    }
    return { verdict: "allowed", signature: payload.signature };
  }
}

function isScreenResponse(
  value: unknown
): value is { blocked: boolean; signature?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).blocked === "boolean"
  );
}

function isScreeningSignature(value: unknown): value is ScreeningSignature {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  // Structural check only — cryptographic validity is verified on-chain. The
  // shape guard turns "the signer emitted nonsense" into retry-then-unavailable
  // instead of relaying garbage.
  return (
    typeof record.issued_at === "number" &&
    Number.isFinite(record.issued_at) &&
    record.issued_at >= 0 &&
    typeof record.sig_r === "string" &&
    HEX_FELT.test(record.sig_r) &&
    typeof record.sig_s === "string" &&
    HEX_FELT.test(record.sig_s)
  );
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
