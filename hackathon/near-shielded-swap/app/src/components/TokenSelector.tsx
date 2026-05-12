import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import type { Token } from "../types";
import { DESTINATION_TOKENS } from "../mocks/tokens";
import { TokenIcon } from "./TokenIcon";

interface Props {
  token: Token;
  onSelect?: (token: Token) => void;
  tokens?: Token[];
  /** If true, render as a static pill (no dropdown). */
  locked?: boolean;
  disabledId?: string;
}

export function TokenSelector({
  token,
  onSelect,
  tokens = DESTINATION_TOKENS,
  locked = false,
  disabledId,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (locked) {
    return (
      <div className="pill cursor-default opacity-95">
        <TokenIcon token={token} size={24} />
        <div className="leading-none">
          <div className="text-sm font-medium tracking-tight">
            {token.symbol}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-foreground-subtle">
            {token.chain}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="pill focus-ring group"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <TokenIcon token={token} size={24} />
        <div className="leading-none">
          <div className="text-sm font-medium tracking-tight">
            {token.symbol}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-foreground-subtle">
            {token.chain}
          </div>
        </div>
        <ChevronDown
          size={14}
          className={`text-foreground-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute right-0 z-30 mt-2 w-80 origin-top-right animate-fade-up overflow-hidden rounded-card border border-border-strong bg-surface-elevated shadow-card"
        >
          <div className="border-b border-border px-4 py-3 text-[11px] uppercase tracking-[0.18em] text-foreground-subtle">
            Destination asset
          </div>
          <ul className="max-h-80 overflow-y-auto py-1">
            {tokens.map((t) => {
              const disabled = t.id === disabledId;
              const active = t.id === token.id;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      onSelect?.(t);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <TokenIcon token={t} size={32} />
                    <div className="flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium text-foreground">
                          {t.symbol}
                        </span>
                        <span className="text-xs text-foreground-subtle">
                          on {t.chain}
                        </span>
                      </div>
                      <div className="text-xs text-foreground-muted">
                        {t.name}
                      </div>
                    </div>
                    {active ? (
                      <Check size={14} className="ml-1 text-accent" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
