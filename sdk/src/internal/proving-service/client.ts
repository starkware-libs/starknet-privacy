/**
 * Proving Service JSON-RPC client.
 * Connects to the Starknet Proving Service (starknet_proveTransaction, starknet_specVersion).
 */

import type { BlockId, ProveTransactionResult, RpcInvokeTransactionV3 } from "./types.js";
import {
  mapProvingServiceError,
  type ProvingServiceError as ProvingServiceErrorType,
} from "./errors.js";

export interface ProvingServiceConfig {
  /** Base URL of the proving service (e.g. http://136.115.124.93:3000) */
  baseUrl: string;
  /** Request timeout in milliseconds (proof generation can be slow; default 120_000) */
  timeoutMs?: number;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: string };
}

/**
 * Client for the Proving Service JSON-RPC API.
 */
export class ProvingServiceClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private requestId = 0;

  constructor(config: ProvingServiceConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  /**
   * Execute a JSON-RPC call.
   */
  async call<T>(method: string, params: unknown): Promise<T> {
    const id = ++this.requestId;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const json = (await response.json()) as JsonRpcResponse<T>;
    if (json.error) {
      const err = mapProvingServiceError(
        json.error.code,
        typeof json.error.data === "string" ? json.error.data : undefined
      );
      throw err;
    }
    if (json.result === undefined) {
      throw new Error("Proving service response missing result");
    }
    return json.result;
  }

  /**
   * Health check and spec version (starknet_specVersion).
   */
  async getSpecVersion(): Promise<string> {
    return this.call<string>("starknet_specVersion", []);
  }

  /**
   * Generate a proof for an Invoke V3 transaction (starknet_proveTransaction).
   */
  async proveTransaction(
    blockId: BlockId,
    transaction: RpcInvokeTransactionV3
  ): Promise<ProveTransactionResult> {
    return this.call<ProveTransactionResult>("starknet_proveTransaction", {
      block_id: blockId,
      transaction,
    });
  }

  /**
   * Check if the service is reachable.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.getSpecVersion();
      return true;
    } catch {
      return false;
    }
  }
}

export type { ProvingServiceErrorType };
