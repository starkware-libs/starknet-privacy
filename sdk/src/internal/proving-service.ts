/**
 * Standalone JSON-RPC client for the proving service (starknet_proveTransaction, etc.).
 * Structured similarly to starknet's RpcProvider.
 */

import type { BlockIdentifier } from "starknet";

/** Default request timeout: 10s (proofs should take ~3-4 seconds). */
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

/** Check result: proof non-empty, proof_facts and l2_to_l1_messages are arrays. */
function isProveTransactionResult(value: unknown): value is ProveTransactionResult {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const r = value as Record<string, unknown>;
  const proof = r.proof;
  const proofOk = typeof proof === "string" && proof.length > 0;
  return proofOk && Array.isArray(r.proof_facts) && Array.isArray(r.l2_to_l1_messages);
}

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

    let res: Response;
    try {
      res = await fetch(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg === "Failed to fetch" ||
        msg.includes("NetworkError") ||
        msg.includes("Load failed")
      ) {
        throw new Error(`Could not reach the proving service at ${this.baseUrl}. `);
      }
      throw err;
    }

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
    transaction: object
  ): Promise<ProveTransactionResult> {
    const result = await this.call<ProveTransactionResult>("starknet_proveTransaction", {
      block_id: blockId,
      transaction,
    });
    if (!isProveTransactionResult(result)) {
      const snippet =
        typeof result === "object" && result !== null
          ? JSON.stringify(result).slice(0, 500)
          : String(result);
      throw new Error(
        `Proving service returned invalid result: expected { proof, proof_facts, l2_to_l1_messages }. Response: ${snippet}`
      );
    }
    return result;
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
