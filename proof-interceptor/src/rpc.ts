// src/rpc.ts
import {
  jsonRpcError,
  type JsonRpcRequest,
  type JsonRpcErrorResponse,
  type ProveTxnV3,
} from "./types.js";

// Error codes matching the real starknet_transaction_prover
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const BLOCK_NOT_FOUND = 24;
const UNSUPPORTED_TX_VERSION = 61;

export enum RpcAction {
  ForwardAsIs = "forward_as_is",
  CheckWithInterceptors = "check_with_interceptors",
  Error = "error",
}

export type RpcVerdict =
  | { action: RpcAction.ForwardAsIs }
  | {
      action: RpcAction.CheckWithInterceptors;
      transaction: ProveTxnV3;
      requestId: string | number | null;
    }
  | { action: RpcAction.Error; response: JsonRpcErrorResponse };

/**
 * Validates a JSON-RPC request body. Returns ForwardAsIs (send raw body to
 * upstream), CheckWithInterceptors (run interceptors then check the transaction),
 * or Error (return error response to the caller).
 */
export function validateRpcRequest(body: string): RpcVerdict {
  let request: JsonRpcRequest;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        action: RpcAction.Error,
        response: jsonRpcError(null, INVALID_REQUEST, "Invalid Request"),
      };
    }
    request = parsed as JsonRpcRequest;
  } catch {
    return {
      action: RpcAction.Error,
      response: jsonRpcError(null, INVALID_REQUEST, "Parse error"),
    };
  }

  if (
    request.jsonrpc !== "2.0" ||
    typeof request.method !== "string" ||
    request.id === undefined
  ) {
    return {
      action: RpcAction.Error,
      response: jsonRpcError(
        request.id ?? null,
        INVALID_REQUEST,
        "Invalid Request"
      ),
    };
  }

  switch (request.method) {
    case "starknet_specVersion":
      return { action: RpcAction.ForwardAsIs };

    case "starknet_checkTransaction":
      return validateCheckTransaction(request);

    default:
      return {
        action: RpcAction.Error,
        response: jsonRpcError(
          request.id,
          METHOD_NOT_FOUND,
          "Method not found"
        ),
      };
  }
}

function validateCheckTransaction(request: JsonRpcRequest): RpcVerdict {
  const params = request.params;
  if (!Array.isArray(params) || params.length < 2) {
    return {
      action: RpcAction.Error,
      response: jsonRpcError(request.id, INVALID_REQUEST, "Invalid Request"),
    };
  }

  const blockId = params[0];
  if (blockId === "pending") {
    return {
      action: RpcAction.Error,
      response: jsonRpcError(request.id, BLOCK_NOT_FOUND, "Block not found"),
    };
  }

  const transaction = params[1] as Record<string, unknown>;
  if (
    typeof transaction !== "object" ||
    transaction === null ||
    Array.isArray(transaction)
  ) {
    return {
      action: RpcAction.Error,
      response: jsonRpcError(request.id, INVALID_REQUEST, "Invalid Request"),
    };
  }

  if (transaction.type !== "INVOKE") {
    return {
      action: RpcAction.Error,
      response: jsonRpcError(
        request.id,
        UNSUPPORTED_TX_VERSION,
        "Unsupported tx version",
        `Only INVOKE transactions are supported, got: ${String(transaction.type)}`
      ),
    };
  }

  if (transaction.version !== "0x3") {
    return {
      action: RpcAction.Error,
      response: jsonRpcError(
        request.id,
        UNSUPPORTED_TX_VERSION,
        "Unsupported tx version",
        `Only version 0x3 is supported, got: ${String(transaction.version)}`
      ),
    };
  }

  if (!Array.isArray(transaction.calldata)) {
    return {
      action: RpcAction.Error,
      response: jsonRpcError(request.id, INVALID_REQUEST, "Invalid Request"),
    };
  }

  return {
    action: RpcAction.CheckWithInterceptors,
    transaction: transaction as unknown as ProveTxnV3,
    requestId: request.id,
  };
}
