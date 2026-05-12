import { useEffect, useRef, useState } from "react";
import type { Token } from "../types";
import {
  previewQuote,
  toBaseUnits,
  type QuoteResult,
} from "../lib/oneclick";

export type QuoteState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; quote: QuoteResult }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

interface UseQuoteParams {
  from: Token;
  to: Token;
  amount: number;
  slippageBps: number;
  recipient?: string;
  refundTo?: string;
  debounceMs?: number;
}

export function useQuote({
  from,
  to,
  amount,
  slippageBps,
  recipient,
  refundTo,
  debounceMs = 350,
}: UseQuoteParams): QuoteState {
  const [state, setState] = useState<QuoteState>({ kind: "idle" });
  const sequenceRef = useRef(0);

  useEffect(() => {
    if (!Number.isFinite(amount) || amount <= 0) {
      setState({ kind: "idle" });
      return;
    }
    if (from.symbol === to.symbol) {
      setState({ kind: "unsupported" });
      return;
    }

    const ticket = ++sequenceRef.current;
    const controller = new AbortController();

    const timeout = window.setTimeout(() => {
      setState({ kind: "loading" });
      previewQuote({
        from,
        to,
        amountIn: toBaseUnits(amount, from.decimals),
        slippageBps,
        recipient,
        refundTo,
        signal: controller.signal,
      })
        .then((result) => {
          if (ticket !== sequenceRef.current) return; // stale
          if (!result) {
            setState({ kind: "unsupported" });
            return;
          }
          setState({ kind: "ready", quote: result });
        })
        .catch((err: unknown) => {
          if (ticket !== sequenceRef.current) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          const message = err instanceof Error ? err.message : String(err);
          setState({ kind: "error", message });
        });
    }, debounceMs);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [from, to, amount, slippageBps, recipient, refundTo, debounceMs]);

  return state;
}
