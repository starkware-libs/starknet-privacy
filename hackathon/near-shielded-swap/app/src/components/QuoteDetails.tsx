import { useEffect, useState } from "react";
import { ChevronDown, Route, ShieldCheck } from "lucide-react";
import type { Quote, Token } from "../types";
import { formatAmount, formatCountdown, formatUsd } from "../lib/format";

interface Props {
  quote: Quote;
  fromToken: Token;
  toToken: Token;
}

export function QuoteDetails({ quote, fromToken, toToken }: Props) {
  const [open, setOpen] = useState(false);
  const [remaining, setRemaining] = useState(quote.deadlineSeconds);

  useEffect(() => {
    setRemaining(quote.deadlineSeconds);
    const id = window.setInterval(() => {
      setRemaining((s) => Math.max(0, s - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [quote.deadlineSeconds, quote.rate]);

  return (
    <div className="rounded-2xl border border-border bg-surface/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left transition hover:bg-surface-muted focus-ring"
      >
        <div className="flex items-center gap-2 text-sm">
          <Route size={14} className="text-accent" />
          <span className="font-mono tabular-nums text-foreground">
            1 {fromToken.symbol} = {formatAmount(quote.rate, 6)} {toToken.symbol}
          </span>
          <span className="text-foreground-subtle">·</span>
          <span className="text-foreground-muted">{quote.routeLabel}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden font-mono text-xs tabular-nums text-foreground-muted sm:inline">
            quote {formatCountdown(remaining)}
          </span>
          <ChevronDown
            size={16}
            className={`text-foreground-muted transition-transform ${open ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <dl className="divide-y divide-border px-4 py-2 text-sm">
            <Row label="Output">
              <span className="font-mono tabular-nums text-foreground">
                {formatAmount(quote.outAmount, 8)} {toToken.symbol}
              </span>
              <span className="text-xs text-foreground-subtle">
                {formatUsd(quote.outUsd)}
              </span>
            </Row>
            <Row label="Max slippage">
              <span className="text-foreground">
                {(quote.slippageBps / 100).toFixed(2)}%
              </span>
            </Row>
            <Row label="Network fee">
              <span className="text-foreground">{formatUsd(quote.networkFeeUsd)}</span>
            </Row>
            <Row label="Route">
              <span className="text-foreground">{quote.routeLabel}</span>
            </Row>
            <Row label="Quote expires">
              <span className="font-mono tabular-nums text-foreground">
                {formatCountdown(remaining)}
              </span>
            </Row>
            <Row label="Destination">
              <span className="inline-flex items-center gap-1.5 rounded-pill bg-pool-ink px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-accent">
                <ShieldCheck size={11} />
                Privacy Pool
              </span>
            </Row>
          </dl>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <dt className="text-foreground-muted">{label}</dt>
      <dd className="flex items-center gap-3">{children}</dd>
    </div>
  );
}
