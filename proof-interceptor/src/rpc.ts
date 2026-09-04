// src/rpc.ts
import { z } from "zod";
import {
  INVOKE_TYPE,
  INVOKE_VERSION,
  jsonRpcError,
  ProveTxnV3Schema,
  RequestIdSchema,
  type JsonRpcErrorResponse,
  type ProveTxnV3,
  type RequestId,
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
      requestId: RequestId;
    }
  | { ok: false; errorType: RpcErrorType; response: JsonRpcErrorResponse };

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: RequestIdSchema,
  method: z.string(),
  params: z.unknown(),
});

/**
 * `starknet_checkTransaction` params, positional or by-name. JSON-RPC 2.0 allows either; the real
 * starknet_transaction_prover's client, the sequencer, sends by-name.
 */
const CheckTransactionParamsSchema = z.union([
  z
    .array(z.unknown())
    .min(2)
    .transform((params) => ({ blockId: params[0], transaction: params[1] })),
  z
    .object({ block_id: z.unknown(), transaction: z.unknown() })
    .refine(
      ({ block_id, transaction }) =>
        block_id !== undefined && transaction !== undefined
    )
    .transform(({ block_id, transaction }) => ({
      blockId: block_id,
      transaction,
    })),
]);

/** Enough of a transaction to route it to an error code; the rest is {@link ProveTxnV3Schema}. */
const TransactionKindSchema = z
  .object({ type: z.unknown(), version: z.unknown() })
  .passthrough();

/**
 * Validates a JSON-RPC request body. On success returns the parsed transaction
 * and request id; on failure returns a ready-to-send JSON-RPC error response.
 */
export function validateRpcRequest(body: string): RpcVerdict {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return {
      ok: false,
      errorType: "parse_error",
      response: jsonRpcError(null, INVALID_REQUEST, "Parse error"),
    };
  }

  const request = JsonRpcRequestSchema.safeParse(parsedBody);
  if (!request.success) return invalidRequest(requestIdOf(parsedBody));

  switch (request.data.method) {
    case "starknet_checkTransaction":
      return validateCheckTransaction(request.data.params, request.data.id);

    default:
      return {
        ok: false,
        errorType: "method_not_found",
        response: jsonRpcError(
          request.data.id,
          METHOD_NOT_FOUND,
          "Method not found"
        ),
      };
  }
}

function validateCheckTransaction(
  rawParams: unknown,
  requestId: RequestId
): RpcVerdict {
  const params = CheckTransactionParamsSchema.safeParse(rawParams);
  if (!params.success) return invalidRequest(requestId);

  if (params.data.blockId === "pending") {
    return {
      ok: false,
      errorType: "block_not_found",
      response: jsonRpcError(requestId, BLOCK_NOT_FOUND, "Block not found"),
    };
  }

  // The kind is read first so a transaction this service does not handle is refused as such,
  // rather than as a malformed one.
  const kind = TransactionKindSchema.safeParse(params.data.transaction);
  if (!kind.success) return invalidRequest(requestId);

  if (kind.data.type !== INVOKE_TYPE) {
    return unsupportedTxVersion(
      requestId,
      `Only ${INVOKE_TYPE} transactions are supported, got: ${String(kind.data.type)}`
    );
  }

  if (kind.data.version !== INVOKE_VERSION) {
    return unsupportedTxVersion(
      requestId,
      `Only version ${INVOKE_VERSION} is supported, got: ${String(kind.data.version)}`
    );
  }

  const transaction = ProveTxnV3Schema.safeParse(params.data.transaction);
  if (!transaction.success) return invalidRequest(requestId);

  return { ok: true, transaction: transaction.data, requestId };
}

/** The id an invalid request still gets its error addressed to, `null` when it carries none. */
function requestIdOf(parsedBody: unknown): RequestId {
  if (typeof parsedBody !== "object" || parsedBody === null) return null;
  const id = RequestIdSchema.safeParse(
    (parsedBody as Record<string, unknown>).id
  );
  return id.success ? id.data : null;
}

function invalidRequest(requestId: RequestId): RpcVerdict {
  return {
    ok: false,
    errorType: "invalid_request",
    response: jsonRpcError(requestId, INVALID_REQUEST, "Invalid Request"),
  };
}

function unsupportedTxVersion(requestId: RequestId, data: string): RpcVerdict {
  return {
    ok: false,
    errorType: "unsupported_tx_version",
    response: jsonRpcError(
      requestId,
      UNSUPPORTED_TX_VERSION,
      "Unsupported tx version",
      data
    ),
  };
}
