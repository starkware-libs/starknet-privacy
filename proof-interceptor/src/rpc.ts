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

export type RpcErrorType =
  | "parse_error"
  | "invalid_request"
  | "method_not_found"
  | "block_not_found"
  | "unsupported_tx_version";

export type RpcVerdict =
  | {
      ok: true;
      transaction: ProveTxnV3;
      requestId: string | number | null;
    }
  | { ok: false; errorType: RpcErrorType; response: JsonRpcErrorResponse };

/**
 * Validates a JSON-RPC request body. On success returns the parsed transaction
 * and request id; on failure returns a ready-to-send JSON-RPC error response.
 */
export function validateRpcRequest(body: string): RpcVerdict {
  let request: JsonRpcRequest;
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        ok: false,
        errorType: "invalid_request",
        response: jsonRpcError(null, INVALID_REQUEST, "Invalid Request"),
      };
    }
    request = parsed as JsonRpcRequest;
  } catch {
    return {
      ok: false,
      errorType: "parse_error",
      response: jsonRpcError(null, INVALID_REQUEST, "Parse error"),
    };
  }

  if (
    request.jsonrpc !== "2.0" ||
    typeof request.method !== "string" ||
    request.id === undefined
  ) {
    return {
      ok: false,
      errorType: "invalid_request",
      response: jsonRpcError(
        request.id ?? null,
        INVALID_REQUEST,
        "Invalid Request"
      ),
    };
  }

  switch (request.method) {
    case "starknet_checkTransaction":
      return validateCheckTransaction(request);

    default:
      return {
        ok: false,
        errorType: "method_not_found",
        response: jsonRpcError(
          request.id,
          METHOD_NOT_FOUND,
          "Method not found"
        ),
      };
  }
}

function validateCheckTransaction(request: JsonRpcRequest): RpcVerdict {
  // JSON-RPC 2.0 allows params as a positional array or a by-name object.
  // The real starknet_transaction_prover's client (sequencer) sends by-name.
  const extracted = extractCheckTransactionParams(request.params);
  if (extracted === null) {
    return {
      ok: false,
      errorType: "invalid_request",
      response: jsonRpcError(request.id, INVALID_REQUEST, "Invalid Request"),
    };
  }
  const { blockId, transaction: rawTransaction } = extracted;

  if (blockId === "pending") {
    return {
      ok: false,
      errorType: "block_not_found",
      response: jsonRpcError(request.id, BLOCK_NOT_FOUND, "Block not found"),
    };
  }

  if (
    typeof rawTransaction !== "object" ||
    rawTransaction === null ||
    Array.isArray(rawTransaction)
  ) {
    return {
      ok: false,
      errorType: "invalid_request",
      response: jsonRpcError(request.id, INVALID_REQUEST, "Invalid Request"),
    };
  }
  const transaction = rawTransaction as Record<string, unknown>;

  if (transaction.type !== "INVOKE") {
    return {
      ok: false,
      errorType: "unsupported_tx_version",
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
      ok: false,
      errorType: "unsupported_tx_version",
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
      ok: false,
      errorType: "invalid_request",
      response: jsonRpcError(request.id, INVALID_REQUEST, "Invalid Request"),
    };
  }

  return {
    ok: true,
    transaction: transaction as unknown as ProveTxnV3,
    requestId: request.id,
  };
}

function extractCheckTransactionParams(
  params: unknown
): { blockId: unknown; transaction: unknown } | null {
  if (Array.isArray(params)) {
    if (params.length < 2) return null;
    return { blockId: params[0], transaction: params[1] };
  }
  if (typeof params === "object" && params !== null) {
    const { block_id, transaction } = params as Record<string, unknown>;
    if (block_id === undefined || transaction === undefined) return null;
    return { blockId: block_id, transaction };
  }
  return null;
}
