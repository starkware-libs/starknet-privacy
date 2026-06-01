/**
 * Standalone JSON-RPC client for the proving service (starknet_proveTransaction, etc.).
 * Structured similarly to starknet's RpcProvider.
 */

import type { BlockIdentifier } from "starknet";
import type { ProofInvocation } from "../interfaces.js";
import { z } from "zod";
import type { OhttpClient } from "./ohttp-client.js";

/** Default request timeout: 30s (proofs typically take a few seconds). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Structured error from the proving service JSON-RPC endpoint.
 *
 * The `code` field is a numeric JSON-RPC error code that callers can switch on:
 *
 * **Prover codes (Starknet RPC v0.10):**
 * - `24`    — Block not found
 * - `55`    — Account validation failed
 * - `61`    — Unsupported transaction version
 * - `1000`  — Invalid transaction input
 * - `-32005` — Service busy (retry later)
 * - `-32603` — Internal prover error
 *
 * **Proxy interceptor codes (1xxxx range):**
 * - `10000` — Transaction rejected (e.g. screening/compliance)
 */
export class ProvingServiceError extends Error {
  override readonly name = "ProvingServiceError";

  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: string
  ) {
    super(data ? `${message}: ${data}` : message);
  }
}

// TODO: Support "latest-verifiable" and { blocksBack: number } server-side; then accept them here and pass through.
// Current server only supports block_id: "latest" | { block_number: N } | { block_hash: "0x..." }.

export interface ProvingServiceConfig {
  baseUrl: string;
  /** Request timeout in ms. Default 30_000 (30 seconds). */
  requestTimeoutMs?: number;
  /** When set, requests are encrypted via OHTTP instead of plain fetch. */
  ohttpClient?: OhttpClient;
}

/** Result of starknet_proveTransaction. */
export interface ProveTransactionResult {
  /** Proof data: base64-encoded binary from the proving service. */
  proof: string;
  proof_facts: string[];
  l2_to_l1_messages: MessageToL1[];
  /**
   * Optional typed side-channel the prover attaches alongside the proof.
   * For screened deposits it carries the screening signature; absent for
   * transactions that need no attestation. Forward-compatible: new capabilities
   * add sibling keys without breaking existing consumers.
   */
  additional_data?: AdditionalData;
}

export interface MessageToL1 {
  from_address: string;
  to_address: string;
  payload: string[];
}

/**
 * Screening attestation produced by the FPI cloud function and relayed by the
 * proof interceptor / prover. The contract verifies it against the proven
 * deposit's `from_addr`.
 *
 * Felts are 0x-hex strings on the wire; `issued_at` is unix seconds.
 */
export interface ScreeningSignature {
  issued_at: number;
  sig_r: string;
  sig_s: string;
}

/** Typed `additional_data` side-channel on a prove response. */
export interface AdditionalData {
  signature?: ScreeningSignature;
}

const MessageToL1Schema = z
  .object({
    from_address: z.string(),
    to_address: z.string(),
    payload: z.array(z.string()),
  })
  .strict();

const ScreeningSignatureSchema = z
  .object({
    issued_at: z.number(),
    sig_r: z.string(),
    sig_s: z.string(),
  })
  .strict();

const AdditionalDataSchema = z
  .object({
    signature: ScreeningSignatureSchema.optional(),
  })
  .strict();

const ProveTransactionResultSchema = z
  .object({
    proof: z.string().min(1),
    proof_facts: z.array(z.string()),
    l2_to_l1_messages: z.array(MessageToL1Schema),
    additional_data: AdditionalDataSchema.optional(),
  })
  .strict();

export class ProvingService {
  private baseUrl: string;
  private requestTimeoutMs: number;
  private ohttpClient?: OhttpClient;

  constructor(config: ProvingServiceConfig) {
    this.baseUrl = config.baseUrl;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.ohttpClient = config.ohttpClient;
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    };

    type JsonRpcResponse = {
      jsonrpc: string;
      id: number;
      result?: T;
      error?: { code: number; message: string; data?: string };
    };

    let json: JsonRpcResponse;

    if (this.ohttpClient) {
      json = await this.ohttpClient.post<JsonRpcResponse>("", body);
    } else {
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

      json = JSON.parse(text) as JsonRpcResponse;
    }

    if (json.error) {
      const { code, message, data } = json.error;
      throw new ProvingServiceError(code, message, typeof data === "string" ? data : undefined);
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
    transaction: ProofInvocation
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
