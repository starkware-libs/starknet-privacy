// src/interceptor.ts
import type { ProveTxnV3 } from "./types.js";
import { interceptorVerdicts, interceptorDuration } from "./metrics.js";

export type Verdict =
  | { action: "continue" }
  | { action: "stop"; reason: string };

export interface TransactionInterceptor {
  name: string;
  intercept(transaction: ProveTxnV3): Promise<Verdict>;
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
      console.error(JSON.stringify({ error: "interceptor_error", message }));
      verdict = { action: "stop", reason: message };
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
