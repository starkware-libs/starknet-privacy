// src/types.ts
import { z } from "zod";

/** A JSON-RPC 2.0 request id: a string, a number, or an explicit null. */
export const RequestIdSchema = z.union([z.string(), z.number(), z.null()]);

export type RequestId = z.infer<typeof RequestIdSchema>;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: RequestId;
  error: JsonRpcError;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: RequestId;
  result: unknown;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/**
 * The fields of a v3 INVOKE this service reads, and therefore the ones it verifies. The prover's
 * wire object carries more — `sender_address`, `signature`, `nonce`, `resource_bounds`, `tip`,
 * `paymaster_data`, `account_deployment_data` and the availability modes — which pass through
 * unread: validating them would reject transactions this service has no opinion on.
 */
const ProveTxnV3Fields = z.object({
  type: z.literal("INVOKE"),
  version: z.literal("0x3"),
  calldata: z.array(z.string()),
});

/** The only transaction type and version this service proves. */
export const INVOKE_TYPE = ProveTxnV3Fields.shape.type.value;
export const INVOKE_VERSION = ProveTxnV3Fields.shape.version.value;

export const ProveTxnV3Schema = ProveTxnV3Fields.passthrough();

/**
 * The strict shape, not `z.infer` of the passthrough parser: an index signature would type every
 * unread field — and every misspelled one — as `unknown` rather than as an error.
 */
export type ProveTxnV3 = z.infer<typeof ProveTxnV3Fields>;

export function jsonRpcError(
  id: RequestId,
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
