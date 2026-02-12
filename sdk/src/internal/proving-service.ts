/**
 * Standalone JSON-RPC client for the proving service (starknet_proveTransaction, etc.).
 * Structured similarly to starknet's RpcProvider.
 */

import { mapProvingServiceError } from "./proving-service-errors.js";

/** Default request timeout: 600s (proofs take ~1–2 min; guide recommends --max-time 600). */
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

export interface ProvingServiceConfig {
  baseUrl: string;
  /** Request timeout in ms. Default 600_000. */
  requestTimeoutMs?: number;
}

/** Result of starknet_proveTransaction. proof is u32[] or base64 string depending on service. */
export interface ProveTransactionResult {
  proof: number[] | string;
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
  const proofOk =
    (Array.isArray(proof) && proof.length > 0) ||
    (typeof proof === "string" && proof.length > 0);
  return (
    proofOk &&
    Array.isArray(r.proof_facts) &&
    Array.isArray(r.l2_to_l1_messages)
  );
}

export type BlockId =
  | "latest"
  | { block_hash: string }
  | { block_number: number };

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
      if (msg === "Failed to fetch" || msg.includes("NetworkError") || msg.includes("Load failed")) {
        throw new Error(
          `Proving service unreachable at ${this.baseUrl}. ` +
            "If running in the browser, the service may not allow CORS—try using the mock prover (unset VITE_PROVING_SERVICE_URL) or a CORS proxy."
        );
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
      throw mapProvingServiceError(json.error);
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
    blockId: BlockId,
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
