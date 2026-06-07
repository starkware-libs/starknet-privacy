import { ProvingServiceError } from "./proving-service.js";

/** Error thrown when a block reorg is detected (HTTP 409 status). */
export class ReorgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReorgError";
  }
}

/**
 * The pool's screening capability could not be resolved from the RPC node.
 *
 * Distinct from a clean entrypoint-not-found revert (which deterministically
 * identifies the current, non-screening pool): this wraps transient or
 * ambiguous failures — network errors, an unreachable node, timeouts, malformed
 * responses. The caller must retry rather than assume a pool shape, because
 * submitting the wrong calldata arity reverts on-chain.
 */
export class PoolCapabilityError extends Error {
  override readonly name = "PoolCapabilityError";
  constructor(poolAddress: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Could not resolve screening capability for pool ${poolAddress}: ${reason}`);
  }
}

/**
 * The deposit's source address is on the sanctions list. Terminal — retrying
 * with the same address will not succeed.
 */
export class ScreeningRejected extends Error {
  override readonly name = "ScreeningRejected";
  constructor(reason?: string) {
    super(reason ? `Deposit screening rejected: ${reason}` : "Deposit screening rejected");
  }
}

/**
 * Screening could not be completed (FPI cloud function or upstream unreachable).
 * Transient — the caller may retry later. Deposits fail closed: no signature
 * means no deposit.
 */
export class ScreeningUnavailable extends Error {
  override readonly name = "ScreeningUnavailable";
  constructor(reason?: string) {
    super(reason ? `Deposit screening unavailable: ${reason}` : "Deposit screening unavailable");
  }
}

/**
 * Opaque `data` reasons the proof interceptor emits on the screening checkpoint.
 * These are the *only* values that denote a screening verdict; they are the
 * contract between this mapper and proof-interceptor `screening-interceptor.ts`
 * (`screenAndSign`) — keep both in sync.
 */
const SCREENING_BLOCKED_REASON = "address_blocked";
const SCREENING_UNAVAILABLE_REASON = "screening_unavailable";

/**
 * Map a {@link ProvingServiceError} to a typed screening error, or `undefined`
 * if it is not a screening verdict so the caller can rethrow the original.
 *
 * Code 10000 ("Transaction rejected") is overloaded — the interceptor also
 * emits it for non-pool blocks and for unexpected interceptor exceptions
 * (whose `data` is the raw error message). We therefore switch on the *exact*
 * opaque reasons above rather than treating every 10000 as terminal: a
 * transient interceptor fault must not be reported as a permanent sanctions
 * rejection the user is told never to retry.
 */
export function screeningErrorFromProvingError(
  error: ProvingServiceError
): ScreeningRejected | ScreeningUnavailable | undefined {
  const TRANSACTION_REJECTED = 10000;
  if (error.code !== TRANSACTION_REJECTED) {
    return undefined;
  }
  if (error.data === SCREENING_UNAVAILABLE_REASON) {
    return new ScreeningUnavailable(error.data);
  }
  if (error.data === SCREENING_BLOCKED_REASON) {
    return new ScreeningRejected(error.data);
  }
  return undefined;
}
