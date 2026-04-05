// src/screening-interceptor.ts
import { createHmac } from "node:crypto";
import { CallData } from "starknet";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import type { TransactionInterceptor, Verdict } from "./interceptor.js";
import type { ProveTxnV3 } from "./types.js";

export interface ScreeningConfig {
  ellipticProxyUrl: string;
  partnerName: string;
  partnerSecret: string;
  timeoutMs: number;
  failOpen: boolean;
  maxRetries: number;
  totalTimeoutMs: number;
}

const ACTIONS_TYPE =
  "core::array::Span::<privacy::actions::ClientAction>" as const;

const callDataDecoder = new CallData(PrivacyPoolABI);

/**
 * Extracts addresses that need screening from a privacy pool transaction,
 * but only if the transaction contains a Deposit action.
 *
 * Expected calldata layout for a single-call INVOKE (calldata[0] === "0x1"):
 *   [0] call_count          — "0x1" for single call
 *   [1] contract_address     — pool contract
 *   [2] selector             — entrypoint selector
 *   [3] inner_calldata_len   — length of inner calldata
 *   [4..] inner calldata     — compile_actions(user_addr, user_private_key, client_actions)
 *
 * The inner calldata is decoded using the contract ABI from the SDK.
 * Only single-call transactions are supported. Multi-call batches (calldata[0]
 * !== "0x1") are passed through without screening.
 */
export function getScreenedAddresses(transaction: ProveTxnV3): string[] {
  const calldata = transaction.calldata;
  if (calldata.length < 7 || calldata[0] !== "0x1") return [];

  const innerCalldataLength = parseInt(calldata[3], 16);
  if (Number.isNaN(innerCalldataLength) || innerCalldataLength < 3) return [];

  const innerCalldata = calldata.slice(4, 4 + innerCalldataLength);

  // innerCalldata[0] = user_addr, [1] = user_private_key, [2..] = actions span
  const actionsCalldata = innerCalldata.slice(2);
  if (!hasDepositAction(actionsCalldata)) return [];

  return [normalizeAddress(innerCalldata[0])];
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

function normalizeAddress(address: string): string {
  const hex = address.startsWith("0x") ? address.slice(2) : address;
  return "0x" + (hex.replace(/^0+/, "") || "0");
}

type ScreenResult = "allowed" | "blocked" | "unavailable";

export class ScreeningInterceptor implements TransactionInterceptor {
  constructor(private readonly config: ScreeningConfig) {}

  async intercept(transaction: ProveTxnV3): Promise<Verdict> {
    const addresses = getScreenedAddresses(transaction);
    if (addresses.length === 0) return { action: "continue" };

    for (const address of addresses) {
      const result = await this.screenAddress(address);
      if (result === "blocked") {
        return {
          action: "stop",
          reason: `address screening: ${address} blocked`,
        };
      }
      if (result === "unavailable") {
        return {
          action: "stop",
          reason: `screening unavailable for ${address}`,
        };
      }
    }

    return { action: "continue" };
  }

  private async screenAddress(address: string): Promise<ScreenResult> {
    let lastError: Error | null = null;
    let finalAttempt = 0;
    const deadline = Date.now() + this.config.totalTimeoutMs;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      finalAttempt = attempt;
      if (attempt > 0) {
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
        console.log(
          JSON.stringify({
            screening: "complete",
            result,
            attempts: attempt + 1,
            screeningLatencyMs: Date.now() - callStart,
          })
        );
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
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
    return this.config.failOpen ? "allowed" : "unavailable";
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
