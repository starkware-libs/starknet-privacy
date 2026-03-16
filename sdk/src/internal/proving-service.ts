/**
 * Standalone JSON-RPC client for the proving service (starknet_proveTransaction, etc.).
 * Structured similarly to starknet's RpcProvider.
 */

import type { INVOKE_TXN_V3 } from "@starknet-io/starknet-types-09";
import type { BlockIdentifier } from "starknet";
import { z } from "zod";

/** Default request timeout: 30s (proofs typically take a few seconds). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// TODO: Support "latest-verifiable" and { blocksBack: number } server-side; then accept them here and pass through.
// Current server only supports block_id: "latest" | { block_number: N } | { block_hash: "0x..." }.

export interface ProvingServiceConfig {
  baseUrl: string;
  /** Request timeout in ms. Default 30_000 (30 seconds). */
  requestTimeoutMs?: number;
}

/** Result of starknet_proveTransaction. */
export interface ProveTransactionResult {
  /** Proof data: base64-encoded binary from the proving service. */
  proof: string;
  proof_facts: string[];
  l2_to_l1_messages: MessageToL1[];
}

export interface MessageToL1 {
  from_address: string;
  to_address: string;
  payload: string[];
}

const MessageToL1Schema = z
  .object({
    from_address: z.string(),
    to_address: z.string(),
    payload: z.array(z.string()),
  })
  .strict();

const ProveTransactionResultSchema = z
  .object({
    proof: z.string().min(1),
    proof_facts: z.array(z.string()),
    l2_to_l1_messages: z.array(MessageToL1Schema),
  })
  .strict();

export class ProvingService {
  private baseUrl: string;
  private requestTimeoutMs: number;

  constructor(config: ProvingServiceConfig) {
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

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Proving service HTTP ${res.status}: ${text}`);
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
      throw new Error(`Proving service error (code ${code}) ${detail}`);
    }

    const result = json.result;
    if (result === undefined) {
      throw new Error("Proving service returned no result");
    }

    return result;
  }

  async getSpecVersion(): Promise<string> {
    return this.call<string>("starknet_specVersion", []);
  }

  async proveTransaction(
    blockId: BlockIdentifier,
    transaction: INVOKE_TXN_V3
  ): Promise<ProveTransactionResult> {
    const blockIdParam =
      typeof blockId === "number" || typeof blockId === "bigint"
        ? { block_number: Number(blockId) }
        : blockId;
    const result = await this.call<ProveTransactionResult>("starknet_proveTransaction", {
      block_id: blockIdParam,
      transaction,
    });
    const parsed = ProveTransactionResultSchema.safeParse(result);
    if (!parsed.success) {
      const snippet =
        typeof result === "object" && result !== null
          ? JSON.stringify(result).slice(0, 500)
          : String(result);
      throw new Error(
        `Proving service returned invalid result: expected { proof, proof_facts, l2_to_l1_messages }. ${parsed.error.message} Response: ${snippet}`
      );
    }
    return parsed.data;
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.getSpecVersion();
      return true;
    } catch {
      return false;
    }
  }
}
