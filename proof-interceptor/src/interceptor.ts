// src/interceptor.ts
import type { ProveTxnV3 } from "./types.js";

export type Verdict =
  | { action: "allow" }
  | { action: "block"; reason: string };

export interface TransactionInterceptor {
  name: string;
  intercept(transaction: ProveTxnV3): Promise<Verdict>;
}

/**
 * Runs all interceptors in parallel. Returns immediately on the first "block"
 * or error. Returns "allow" only if all interceptors return "allow".
 */
export async function runInterceptors(
  interceptors: TransactionInterceptor[],
  transaction: ProveTxnV3
): Promise<Verdict> {
  if (interceptors.length === 0) return { action: "allow" };

  const promises = interceptors.map((interceptor) =>
    interceptor.intercept(transaction).catch((error): Verdict => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          error: "interceptor_error",
          interceptor: interceptor.name,
          message,
        })
      );
      return { action: "block", reason: message };
    })
  );

  const blockPromises = promises.map(async (promise) => {
    const verdict = await promise;
    if (verdict.action === "block") return verdict;
    return new Promise<Verdict>(() => {});
  });

  const allAllow = Promise.all(promises).then(
    (): Verdict => ({ action: "allow" })
  );

  return Promise.race([...blockPromises, allAllow]);
}
