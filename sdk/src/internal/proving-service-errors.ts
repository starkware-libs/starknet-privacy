/**
 * Typed errors for the Proving Service JSON-RPC API.
 * Error codes follow Starknet RPC v0.10.
 */

/** Base error for all proving service JSON-RPC errors. */
export class ProvingServiceError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: string
  ) {
    super(data ? `${message}: ${data}` : message);
    this.name = "ProvingServiceError";
    Object.setPrototypeOf(this, ProvingServiceError.prototype);
  }
}

/** Invalid block ID, block doesn't exist, or "pending" requested (code 24). Do not retry. */
export class BlockNotFoundError extends ProvingServiceError {
  constructor(data?: string) {
    super(24, "Block not found", data);
    this.name = "BlockNotFoundError";
    Object.setPrototypeOf(this, BlockNotFoundError.prototype);
  }
}

/** Transaction hash computation failed (code 25). Do not retry. */
export class InvalidTransactionHashError extends ProvingServiceError {
  constructor(data?: string) {
    super(25, "Invalid transaction hash", data);
    this.name = "InvalidTransactionHashError";
    Object.setPrototypeOf(this, InvalidTransactionHashError.prototype);
  }
}

/** Transaction validation failed — invalid signature, nonce, etc. (code 55). Do not retry. */
export class ValidationFailedError extends ProvingServiceError {
  constructor(data?: string) {
    super(55, "Account validation failed", data);
    this.name = "ValidationFailedError";
    Object.setPrototypeOf(this, ValidationFailedError.prototype);
  }
}

/** Non-Invoke or non-V3 transaction provided (code 61). Do not retry. */
export class UnsupportedTransactionVersionError extends ProvingServiceError {
  constructor(data?: string) {
    super(61, "The transaction version is not supported", data);
    this.name = "UnsupportedTransactionVersionError";
    Object.setPrototypeOf(this, UnsupportedTransactionVersionError.prototype);
  }
}

/** Server-side errors — prover failure, RPC node issues (code -32603). Retryable. */
export class ProvingServiceInternalError extends ProvingServiceError {
  constructor(data?: string) {
    super(-32603, "Internal error", data);
    this.name = "ProvingServiceInternalError";
    Object.setPrototypeOf(this, ProvingServiceInternalError.prototype);
  }
}

/** Map JSON-RPC error code to typed exception. */
export function mapProvingServiceError(error: {
  code: number;
  message: string;
  data?: string;
}): ProvingServiceError {
  const data = typeof error.data === "string" ? error.data : undefined;
  switch (error.code) {
    case 24:
      return new BlockNotFoundError(data);
    case 25:
      return new InvalidTransactionHashError(data);
    case 55:
      return new ValidationFailedError(data);
    case 61:
      return new UnsupportedTransactionVersionError(data);
    case -32603:
      return new ProvingServiceInternalError(data);
    default:
      return new ProvingServiceError(error.code, error.message, data);
  }
}
