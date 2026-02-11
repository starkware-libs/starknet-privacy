/**
 * Proving Service JSON-RPC error types (Starknet RPC v0.10 codes).
 */

export class ProvingServiceError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: string
  ) {
    super(message);
    this.name = "ProvingServiceError";
  }
}

export class BlockNotFoundError extends ProvingServiceError {
  constructor(data?: string) {
    super(24, "Block not found", data);
    this.name = "BlockNotFoundError";
  }
}

export class InvalidTransactionHashError extends ProvingServiceError {
  constructor(data?: string) {
    super(25, "Invalid transaction hash", data);
    this.name = "InvalidTransactionHashError";
  }
}

export class ValidationFailedError extends ProvingServiceError {
  constructor(data?: string) {
    super(55, "Account validation failed", data);
    this.name = "ValidationFailedError";
  }
}

export class UnsupportedTransactionVersionError extends ProvingServiceError {
  constructor(data?: string) {
    super(61, "The transaction version is not supported", data);
    this.name = "UnsupportedTransactionVersionError";
  }
}

export class InternalProvingError extends ProvingServiceError {
  constructor(data?: string) {
    super(-32603, "Internal error", data);
    this.name = "InternalProvingError";
  }
}

export function mapProvingServiceError(code: number, data?: string): ProvingServiceError {
  switch (code) {
    case 24:
      return new BlockNotFoundError(data);
    case 25:
      return new InvalidTransactionHashError(data);
    case 55:
      return new ValidationFailedError(data);
    case 61:
      return new UnsupportedTransactionVersionError(data);
    default:
      return new InternalProvingError(data);
  }
}
