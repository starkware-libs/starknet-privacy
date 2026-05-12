import { useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import type { PendingSwap, SwapStage } from "../types";
import { MOCK_PENDING } from "../mocks/pendingSwaps";
import { formatAmount, formatRelative } from "../lib/format";
import { TokenIcon } from "./TokenIcon";
import { TOKEN_BY_SYMBOL } from "../mocks/tokens";

const STAGE_LABELS: Record<SwapStage, string> = {
  quote: "Quote",
  exit: "Exit Tx",
  settling: "NEAR Settling",
  claim: "Claim Tx",
};

const STAGE_ORDER: SwapStage[] = ["quote", "exit", "settling", "claim"];

interface Props {
  swaps?: PendingSwap[];
}

export function SwapTimeline({ swaps = MOCK_PENDING }: Props) {
  if (swaps.length === 0) return null;

  return (
    <section
      className="w-full max-w-[480px] animate-fade-up"
      style={{ animationDelay: "120ms" }}
      aria-label="Pending swaps"
    >
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-foreground-muted">
          Pending swaps
        </h2>
        <span className="text-xs text-foreground-subtle">
          {swaps.length} active
        </span>
      </div>

      <ul className="space-y-2">
        {swaps.map((swap) => (
          <SwapRow key={swap.id} swap={swap} />
        ))}
      </ul>
    </section>
  );
}

function SwapRow({ swap }: { swap: PendingSwap }) {
  const [open, setOpen] = useState(true);
  const from = TOKEN_BY_SYMBOL[swap.fromSymbol];
  const to = TOKEN_BY_SYMBOL[swap.toSymbol];

  return (
    <li className="rounded-card border border-border bg-surface-elevated/70 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left focus-ring"
      >
        <div className="flex items-center gap-3">
          <div className="flex -space-x-2">
            {from ? <TokenIcon token={from} size={26} /> : null}
            {to ? <TokenIcon token={to} size={26} /> : null}
          </div>
          <div className="leading-tight">
            <div className="font-mono text-sm tabular-nums text-foreground">
              {formatAmount(swap.fromAmount, 4)} {swap.fromSymbol}
              <span className="mx-1.5 text-foreground-subtle">→</span>
              {formatAmount(swap.toAmount, 6)} {swap.toSymbol}
            </div>
            <div className="text-[11px] text-foreground-subtle">
              started {formatRelative(swap.startedAt)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-foreground-muted">
          <ActiveDotLabel swap={swap} />
          <ChevronDown
            size={14}
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
          <div className="mt-4 px-1">
            <StageStepper swap={swap} />
          </div>
        </div>
      </div>
    </li>
  );
}

function ActiveDotLabel({ swap }: { swap: PendingSwap }) {
  const active = STAGE_ORDER.find((s) => swap.stages[s] === "active");
  if (!active) return <span className="text-accent">Complete</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-1.5 animate-pulse-dot rounded-full bg-accent" />
      <span>{STAGE_LABELS[active]}</span>
    </span>
  );
}

function StageStepper({ swap }: { swap: PendingSwap }) {
  return (
    <ol className="grid grid-cols-4 gap-2">
      {STAGE_ORDER.map((stage, idx) => {
        const status = swap.stages[stage];
        const next = STAGE_ORDER[idx + 1];
        const connectorOn = status === "done" || (next && swap.stages[next] !== "idle");
        return (
          <li key={stage} className="relative flex flex-col items-center">
            {idx < STAGE_ORDER.length - 1 ? (
              <span
                aria-hidden
                className={`absolute left-1/2 top-3 h-px w-full ${
                  connectorOn ? "bg-accent/50" : "bg-border-strong"
                }`}
              />
            ) : null}

            <span
              className={`relative z-10 flex size-6 items-center justify-center rounded-full border ${
                status === "done"
                  ? "border-accent bg-accent text-accent-foreground"
                  : status === "active"
                    ? "border-accent bg-surface-elevated text-accent"
                    : "border-border-strong bg-surface-elevated text-foreground-subtle"
              }`}
            >
              {status === "done" ? (
                <Check size={12} strokeWidth={3} />
              ) : status === "active" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <span className="size-1 rounded-full bg-current" />
              )}
            </span>

            <span
              className={`mt-2 text-[11px] tracking-tight ${
                status === "idle"
                  ? "text-foreground-subtle"
                  : "text-foreground-muted"
              }`}
            >
              {STAGE_LABELS[stage]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
