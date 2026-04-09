// src/interceptor.ts
import type { ProveTxnV3 } from "./types.js";
import { interceptorVerdicts, interceptorDuration } from "./metrics.js";

export type Verdict =
  | { action: "continue" }
  | { action: "stop"; reason: string };

export interface TransactionInterceptor {
  name: string;
  intercept(transaction: ProveTxnV3): Promise<Verdict>;
  /** If true (default), exceptions from intercept() become "stop". If false, they become "continue". */
  blocking?: boolean;
  /** Called with the error code and the same transaction passed to intercept(). */
  error?(code: number, transaction: ProveTxnV3): Promise<void>;
  /** Called on the success path to clean up per-transaction state. */
  complete?(transaction: ProveTxnV3): void;
}

/**
 * Runs all interceptors in parallel. Returns immediately on the first "stop"
 * or error. Returns "continue" only if all interceptors return "continue".
 * Records per-interceptor metrics (verdict count and duration).
 */
export async function runInterceptors(
  interceptors: TransactionInterceptor[],
  transaction: ProveTxnV3
): Promise<Verdict> {
  if (interceptors.length === 0) return { action: "continue" };

  const promises = interceptors.map(async (interceptor) => {
    const startTime = Date.now();
    let verdict: Verdict;
    try {
      verdict = await interceptor.intercept(transaction);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          error: "interceptor_error",
          interceptor: interceptor.name,
          message,
        })
      );
      // Non-blocking interceptors swallow exceptions as "continue"
      verdict =
        (interceptor.blocking ?? true)
          ? { action: "stop", reason: message }
          : { action: "continue" };
    }
    const durationSeconds = (Date.now() - startTime) / 1000;

    interceptorVerdicts.inc({
      interceptor: interceptor.name,
      verdict: verdict.action,
    });
    interceptorDuration.observe(
      { interceptor: interceptor.name, verdict: verdict.action },
      durationSeconds
    );

    return verdict;
  });

  // Race: first "stop" wins immediately; if all continue, Promise.all resolves
  const stopPromises = promises.map(async (promise) => {
    const verdict = await promise;
    if (verdict.action === "stop") return verdict;
    // Never resolve — only stops participate in the race
    return new Promise<Verdict>(() => {});
  });

  const allContinue = Promise.all(promises).then(
    (): Verdict => ({ action: "continue" })
  );

  return Promise.race([...stopPromises, allContinue]);
}

/**
 * Calls error() on all interceptors that implement it.
 * Exceptions from individual error() handlers are logged but not propagated.
 */
export async function notifyInterceptorError(
  interceptors: TransactionInterceptor[],
  code: number,
  transaction: ProveTxnV3
): Promise<void> {
  await Promise.all(
    interceptors
      .filter((interceptor) => interceptor.error)
      .map((interceptor) =>
        interceptor.error!(code, transaction).catch((error) => {
          console.error(
            JSON.stringify({
              error: "interceptor_error_handler_failed",
              interceptor: interceptor.name,
              message: String(error),
            })
          );
        })
      )
  );
}

/**
 * Calls complete() on all interceptors that implement it, to clean up per-transaction state.
 */
export function notifyInterceptorComplete(
  interceptors: TransactionInterceptor[],
  transaction: ProveTxnV3
): void {
  for (const interceptor of interceptors) {
    interceptor.complete?.(transaction);
  }
}
