/**
 * PaymasterService — JSON-RPC client for the paymaster API.
 * Follows the same pattern as ProvingService (JSON-RPC, Zod validation, AbortSignal timeout).
 */

import { z } from "zod";
import type { FeeProviderInterface, FeeSchedule, StarknetAddress } from "../../interfaces.js";
import { toHex } from "../../utils/convert.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface PaymasterServiceConfig {
  baseUrl: string;
  /** Request timeout in ms. Default 30_000 (30 seconds). */
  requestTimeoutMs?: number;
}

const InvokeFeesSchema = z.record(z.string(), z.string());

const FeeScheduleSchema = z.object({
  feeRecipient: z.string(),
  baseFee: z.string(),
  perAction: z.object({
    writeOnce: z.string(),
    append: z.string(),
    transferFrom: z.string(),
    transferTo: z.string(),
    emitViewingKeySet: z.string(),
    emitWithdrawal: z.string(),
    emitDeposit: z.string(),
    emitOpenNoteCreated: z.string(),
    emitEncNoteCreated: z.string(),
    emitNoteUsed: z.string(),
    invoke: InvokeFeesSchema,
  }),
  gasPrice: z.string(),
  validUntil: z.number(),
});

export class PaymasterService implements FeeProviderInterface {
  private baseUrl: string;
  private requestTimeoutMs: number;
  private cache = new Map<string, { schedule: FeeSchedule; validUntil: number }>();

  constructor(config: PaymasterServiceConfig) {
    this.baseUrl = config.baseUrl;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    };

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Paymaster service HTTP ${response.status}: ${text}`);
    }

    const json = JSON.parse(text) as {
      jsonrpc: string;
      id: number;
      result?: T;
      error?: { code: number; message: string; data?: string };
    };

    if (json.error) {
      const { code, message, data } = json.error;
      const detail = typeof data === "string" ? `${message}: ${data}` : message;
      throw new Error(`Paymaster service error (code ${code}) ${detail}`);
    }

    const result = json.result;
    if (result === undefined) {
      throw new Error("Paymaster service returned no result");
    }

    return result;
  }

  async getFeeQuote(token: StarknetAddress): Promise<FeeSchedule> {
    const cacheKey = toHex(token);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.validUntil * 1000) {
      return cached.schedule;
    }

    const result = await this.call<FeeSchedule>("paymaster_getFeeQuote", {
      token: cacheKey,
    });

    const parsed = FeeScheduleSchema.safeParse(result);
    if (!parsed.success) {
      const snippet =
        typeof result === "object" && result !== null
          ? JSON.stringify(result).slice(0, 500)
          : String(result);
      throw new Error(
        `Paymaster service returned invalid fee schedule: ${parsed.error.message} Response: ${snippet}`
      );
    }

    this.cache.set(cacheKey, {
      schedule: parsed.data,
      validUntil: parsed.data.validUntil,
    });

    return parsed.data;
  }
}
