/**
 * TracingRpcProvider - Enhanced RPC provider that enriches errors with transaction traces
 *
 * When a transaction fails, this provider automatically fetches the execution trace
 * and decodes error messages and function selectors for easier debugging.
 */

import {
  RpcProvider,
  type RpcProviderOptions,
  type GetTransactionReceiptResponse,
  type TransactionTrace,
  type waitForTransactionOptions,
} from "starknet";
import { decodeError, type DecodedError } from "../utils/error-decoder.js";

// Re-export DecodedError for consumers
export type { DecodedError };

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
