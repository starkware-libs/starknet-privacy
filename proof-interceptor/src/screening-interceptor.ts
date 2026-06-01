// src/screening-interceptor.ts
import { createHmac } from "node:crypto";
import { CallData } from "starknet";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import type {
  ScreeningSignature,
  TransactionInterceptor,
  Verdict,
} from "./interceptor.js";
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
  // When true, transactions that are not a single direct INVOKE call to
  // `poolAddress` are blocked outright. When false (default), such transactions
  // bypass screening and are allowed through.
  blockNonPoolTx: boolean;
}

const ACTIONS_TYPE =
  "core::array::Span::<privacy::actions::ClientAction>" as const;

const callDataDecoder = new CallData(PrivacyPoolABI);

// Capped at the canonical zero-padded address width (64 hex digits), matching
// the proxy's felt validation.
const HEX_FELT = /^0x[0-9a-fA-F]{1,64}$/;

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

type SignOutcome =
  | { result: "allowed"; signature: ScreeningSignature }
  | { result: "blocked" }
  | { result: "unavailable" };

export class ScreeningInterceptor implements TransactionInterceptor {
  readonly name = "screening";

  constructor(private readonly config: ScreeningConfig) {}

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

    // A deposit yields exactly one screened address: the depositor (user_addr),
    // which the contract binds to the proven TransferFrom.from_addr. Screen and
    // sign it in one /screen call. Reasons are opaque codes — they surface to
    // the client as JSON-RPC error `data` and must not reveal the depositor.
    const depositor = addresses[0];
    const outcome = await this.screenAndSign(depositor);
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
  // Fail closed on a structurally-present-but-garbage signature: a NaN/Infinity
  // issued_at or a non-hex sig_r/sig_s is relayed to the prover otherwise. The
  // chain rejects a bad signature regardless, but a tight guard turns "the
  // signer emitted nonsense" into a retry-then-unavailable instead of an allow.
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
