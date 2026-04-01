// src/types.ts
import type { SPEC } from "@starknet-io/types-js";

export type ProveTxnV3 = SPEC.INVOKE_TXN_V3;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown[];
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcError;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data !== undefined ? { code, message, data } : { code, message },
  };
}
