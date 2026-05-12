import { useEffect, useRef, useState } from "react";
import { Settings2, Info } from "lucide-react";

interface Props {
  slippageBps: number;
  onChange: (bps: number) => void;
}

const PRESETS = [10, 50, 100];

export function SettingsMenu({ slippageBps, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-pill border border-transparent p-2 text-foreground-muted transition hover:border-border-strong hover:bg-surface-muted hover:text-foreground focus-ring"
        aria-label="Swap settings"
      >
        <Settings2 size={16} />
      </button>

      {open ? (
        <div className="absolute right-0 z-30 mt-2 w-72 origin-top-right animate-fade-up rounded-card border border-border-strong bg-surface-elevated p-4 shadow-card">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">Max slippage</span>
            <span
              title="Maximum tolerated price movement before the swap reverts."
              className="text-foreground-subtle"
            >
              <Info size={13} />
            </span>
          </div>
          <div className="flex gap-1.5">
            {PRESETS.map((bps) => {
              const active = bps === slippageBps;
              return (
                <button
                  key={bps}
                  type="button"
                  onClick={() => onChange(bps)}
                  className={`flex-1 rounded-pill border px-3 py-1.5 text-xs font-medium transition ${
                    active
                      ? "border-accent/60 bg-accent/10 text-accent"
                      : "border-border bg-surface-muted text-foreground-muted hover:border-border-strong hover:text-foreground"
                  }`}
                >
                  {(bps / 100).toFixed(bps < 100 ? 2 : 1)}%
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-foreground-subtle">
            Tighter slippage protects you from MEV. Cross-chain quotes settle
            over ~30–120s, so loose values may be safer at small sizes.
          </p>
        </div>
      ) : null}
    </div>
  );
}
