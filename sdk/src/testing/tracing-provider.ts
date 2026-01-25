/**
 * TracingRpcProvider - Enhanced RPC provider that enriches errors with transaction traces
 *
 * When a transaction fails, this provider automatically fetches the execution trace
 * and decodes error messages and function selectors for easier debugging.
 */

import {
  RpcProvider,
  hash,
  type RpcProviderOptions,
  type GetTransactionReceiptResponse,
  type TransactionTrace,
  type waitForTransactionOptions,
} from "starknet";

// Common Starknet function names for selector lookup
const COMMON_FUNCTIONS = [
  // Account functions
  "__execute__",
  "__validate__",
  "__validate_declare__",
  "__validate_deploy__",
  "is_valid_signature",
  "get_nonce",
  // ERC20
  "transfer",
  "transfer_from",
  "approve",
  "balance_of",
  "allowance",
  "total_supply",
  "name",
  "symbol",
  "decimals",
  // Outside execution (SNIP-9)
  "execute_from_outside",
  "execute_from_outside_v2",
  "is_valid_outside_execution_nonce",
  // Ownable
  "owner",
  "transfer_ownership",
  "renounce_ownership",
  // Privacy pool specific
  "register",
  "deposit",
  "withdraw",
  "get_public_key",
  "set_viewing_key",
  "get_note",
  "get_nullifier",
  "get_channel",
];

// Build selector -> name map
const selectorToName = new Map<string, string>();
for (const name of COMMON_FUNCTIONS) {
  const selector = hash.getSelectorFromName(name);
  selectorToName.set(selector.toLowerCase(), name);
}

/**
 * Decoded error information
 */
export interface DecodedError {
  /** Original error object/string */
  raw: unknown;
  /** Decoded with human-readable selectors and error messages */
  decoded: unknown;
}

/**
 * Enhanced error that includes transaction trace and decoded information
 */
export class TracedRpcError extends Error {
  public readonly name = "TracedRpcError";

  constructor(
    public readonly originalError: Error,
    public readonly transactionHash: string,
    public readonly trace?: TransactionTrace,
    public readonly decodedError?: DecodedError
  ) {
    const decodedMsg = decodedError
      ? `\nDecoded: ${JSON.stringify(decodedError.decoded, null, 2)}`
      : "";
    super(`${originalError.message}${decodedMsg}`);

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TracedRpcError);
    }
  }
}

/**
 * Look up a selector hex value to get the function name
 */
function lookupSelector(selectorHex: string): string | undefined {
  const normalized = selectorHex.toLowerCase();
  if (selectorToName.has(normalized)) {
    return selectorToName.get(normalized);
  }

  // Try matching without 0x prefix padding differences
  try {
    const selectorBigInt = BigInt(selectorHex);
    for (const [key, name] of selectorToName.entries()) {
      if (BigInt(key) === selectorBigInt) {
        return name;
      }
    }
  } catch {
    // Invalid hex, return undefined
  }

  return undefined;
}

/**
 * Convert hex to ASCII string if it looks like text
 */
function hexToString(hex: unknown): unknown {
  if (!hex || typeof hex !== "string") return hex;
  if (!hex.startsWith("0x")) return hex;

  const cleanHex = hex.slice(2);
  let str = "";
  for (let i = 0; i < cleanHex.length; i += 2) {
    const charCode = parseInt(cleanHex.substr(i, 2), 16);
    if (charCode >= 32 && charCode <= 126) {
      str += String.fromCharCode(charCode);
    } else {
      return hex; // Not ASCII, return original
    }
  }
  return str || hex;
}

/**
 * Decode an array of hex error values
 */
function decodeErrorArray(arr: unknown[]): unknown[] {
  return arr.map((item) => {
    if (typeof item === "string") {
      const decoded = hexToString(item);
      return decoded !== item ? `${decoded} (${item})` : item;
    }
    return decodeValue(item);
  });
}

/**
 * Recursively decode error objects, arrays, and hex strings
 */
function decodeValue(obj: unknown): unknown {
  if (typeof obj === "string") {
    // Try to parse as JSON
    try {
      return decodeValue(JSON.parse(obj));
    } catch {
      // Single hex value
      const decoded = hexToString(obj);
      return decoded !== obj ? `${decoded} (${obj})` : obj;
    }
  }

  if (Array.isArray(obj)) {
    return decodeErrorArray(obj);
  }

  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === "selector" && typeof value === "string") {
        // Look up selector name
        const funcName = lookupSelector(value);
        result[key] = funcName ? `${funcName} (${value})` : value;
      } else if (key === "error" && typeof value === "string" && value.startsWith("[")) {
        // Parse array string like "[\"0x...\",\"0x...\"]"
        try {
          const arr = JSON.parse(value);
          result[key] = decodeErrorArray(arr);
        } catch {
          result[key] = decodeValue(value);
        }
      } else {
        result[key] = decodeValue(value);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Decode error from an RPC error or transaction trace
 */
function decodeError(error: unknown): DecodedError {
  return {
    raw: error,
    decoded: decodeValue(error),
  };
}

/**
 * RPC Provider that automatically enriches errors with transaction traces.
 *
 * When waitForTransaction encounters a failed transaction, it will:
 * 1. Fetch the transaction trace
 * 2. Decode hex error messages and function selectors
 * 3. Throw a TracedRpcError with all debugging information
 */
export class TracingRpcProvider extends RpcProvider {
  constructor(options: RpcProviderOptions) {
    super(options);
  }

  /**
   * Wait for a transaction and enrich errors with traces on failure
   */
  async waitForTransaction(
    txHash: string,
    options?: waitForTransactionOptions
  ): Promise<GetTransactionReceiptResponse> {
    try {
      return await super.waitForTransaction(txHash, options);
    } catch (error) {
      // Try to enrich the error with a trace
      const enrichedError = await this.enrichError(error, txHash);
      throw enrichedError;
    }
  }

  /**
   * Enrich an error with transaction trace and decoded information
   */
  private async enrichError(error: unknown, txHash: string): Promise<Error> {
    if (!(error instanceof Error)) {
      return new TracedRpcError(new Error(String(error)), txHash);
    }

    try {
      const trace = await this.getTransactionTrace(txHash);
      // Try to extract revert reason from trace
      const revertReason = this.extractRevertReason(trace);
      const decoded = revertReason ? decodeError(revertReason) : undefined;
      return new TracedRpcError(error, txHash, trace, decoded);
    } catch {
      // Trace not available, return error with just txHash
      // Also try to decode the original error message
      const decoded = this.tryDecodeErrorMessage(error);
      return new TracedRpcError(error, txHash, undefined, decoded);
    }
  }

  /**
   * Extract revert reason from a transaction trace
   */
  private extractRevertReason(trace: TransactionTrace): unknown {
    // The trace structure varies, but revert reasons are typically in:
    // - trace.revert_reason
    // - trace.execute_invocation?.revert_reason
    // - nested in function_invocation results
    const traceAny = trace as Record<string, unknown>;

    if (traceAny.revert_reason) {
      return traceAny.revert_reason;
    }

    if (
      traceAny.execute_invocation &&
      typeof traceAny.execute_invocation === "object" &&
      traceAny.execute_invocation !== null
    ) {
      const execInvocation = traceAny.execute_invocation as Record<string, unknown>;
      if (execInvocation.revert_reason) {
        return execInvocation.revert_reason;
      }
    }

    return undefined;
  }

  /**
   * Try to decode error message from an Error object
   */
  private tryDecodeErrorMessage(error: Error): DecodedError | undefined {
    // Check if error has additional data (common in RpcError)
    const errorAny = error as unknown as Record<string, unknown>;

    if (errorAny.baseError) {
      return decodeError(errorAny.baseError);
    }

    if (errorAny.data) {
      return decodeError(errorAny.data);
    }

    // Try to parse error message as JSON
    try {
      const parsed = JSON.parse(error.message);
      return decodeError(parsed);
    } catch {
      // Not JSON, return undefined
    }

    return undefined;
  }
}
