// src/interceptor.ts
import type { ProveTxnV3 } from "./types.js";

export type Verdict =
  | { action: "continue" }
  | { action: "stop"; reason: string };

export interface TransactionInterceptor {
  intercept(transaction: ProveTxnV3): Promise<Verdict>;
}

/**
 * Runs all interceptors in parallel. Returns immediately on the first "stop"
 * or error. Returns "continue" only if all interceptors return "continue".
 */
export async function runInterceptors(
  interceptors: TransactionInterceptor[],
  transaction: ProveTxnV3
): Promise<Verdict> {
  if (interceptors.length === 0) return { action: "continue" };

  const promises = interceptors.map((interceptor) =>
    interceptor.intercept(transaction).catch((error): Verdict => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({ error: "interceptor_error", message })
      );
      return { action: "stop", reason: message };
    })
  );

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
