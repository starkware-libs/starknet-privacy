// src/interceptor.ts
import type { ProveTxnV3 } from "./types.js";
import { logger } from "./logger.js";
import {
  interceptorVerdicts,
  interceptorDuration,
  interceptorErrors,
  errorsTotal,
} from "./metrics.js";

export type Verdict = { action: "allow" } | { action: "block"; reason: string };

/**
 * Optional health snapshot exposed by an interceptor. Returned by the
 * /health endpoint when any interceptor implements `health()`. The body
 * intentionally contains no internal state (timestamps, error counts) —
 * /health is a load-balancer probe, not a debug endpoint.
 */
export interface InterceptorHealth {
  healthy: boolean;
  /** Short, opaque code summarizing why the interceptor is unhealthy. */
  reason?: string;
}

export interface TransactionInterceptor {
  name: string;
  intercept(transaction: ProveTxnV3): Promise<Verdict>;
  /**
   * Optional. When provided, /health calls it for each registered interceptor.
   * /health returns 503 if any interceptor reports `healthy: false`.
   */
  health?(): InterceptorHealth;
}

/**
 * Runs all interceptors in parallel. Returns immediately on the first "block"
 * or error. Returns "allow" only if all interceptors return "allow".
 * Records per-interceptor metrics (verdict count and duration).
 */
export async function runInterceptors(
  interceptors: TransactionInterceptor[],
  transaction: ProveTxnV3
): Promise<Verdict> {
  if (interceptors.length === 0) return { action: "allow" };

  const promises = interceptors.map(async (interceptor) => {
    const startTime = Date.now();
    let verdict: Verdict;
    try {
      verdict = await interceptor.intercept(transaction);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({
        event: "interceptor_error",
        interceptor: interceptor.name,
        message,
      });
      errorsTotal.inc({ type: "interceptor_error" });
      interceptorErrors.inc({ interceptor: interceptor.name });
      verdict = { action: "block", reason: message };
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

  // Race: first "block" wins immediately; if all allow, Promise.all resolves
  const blockPromises = promises.map(async (promise) => {
    const verdict = await promise;
    if (verdict.action === "block") return verdict;
    // Never resolve — only blocks participate in the race
    return new Promise<Verdict>(() => {});
  });

  const allAllow = Promise.all(promises).then(
    (): Verdict => ({ action: "allow" })
  );

  return Promise.race([...blockPromises, allAllow]);
}
