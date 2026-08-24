// src/types.ts
import { z } from "zod";

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

/**
 * The fields of a v3 INVOKE this service reads, and therefore the ones it verifies. The prover's
 * wire object carries more — `sender_address`, `signature`, `nonce`, `resource_bounds`, `tip`,
 * `paymaster_data`, `account_deployment_data` and the availability modes — which pass through
 * unread: validating them would reject transactions this service has no opinion on.
 */
export const ProveTxnV3Schema = z
  .object({
    type: z.literal("INVOKE"),
    version: z.literal("0x3"),
    calldata: z.array(z.string()),
  })
  .passthrough();

export type ProveTxnV3 = z.infer<typeof ProveTxnV3Schema>;

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
