// src/interceptor.ts
import type { ProveTxnV3 } from "./types.js";
import {
  interceptorVerdicts,
  interceptorDuration,
  errorsTotal,
} from "./metrics.js";

/**
 * Screening attestation relayed from the FPI cloud function on an allowed
 * deposit. Snake_case mirrors the wire shape end-to-end: elliptic-proxy /screen
 * → this verdict → the prover's `additional_data.signature` → the SDK.
 */
export interface ScreeningSignature {
  issued_at: number;
  sig_r: string;
  sig_s: string;
}

export type Verdict =
  | { action: "allow"; signature?: ScreeningSignature }
  | { action: "block"; reason: string };

export interface TransactionInterceptor {
  name: string;
  intercept(transaction: ProveTxnV3): Promise<Verdict>;
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
      console.error(JSON.stringify({ error: "interceptor_error", message }));
      errorsTotal.inc({ type: "interceptor_error" });
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

  // When every interceptor allows, preserve any signature one of them attached
  // (only the screening interceptor does, on a deposit). All verdicts here are
  // allows — a block would have won the race below before this resolves.
  const allAllow = Promise.all(promises).then((verdicts): Verdict => {
    const signed = verdicts.find(
      (verdict) => verdict.action === "allow" && verdict.signature !== undefined
    );
    return signed ?? { action: "allow" };
  });

  return Promise.race([...blockPromises, allAllow]);
}
