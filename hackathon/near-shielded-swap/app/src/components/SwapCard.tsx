import { useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { WithdrawForm } from "./WithdrawForm";
import { DepositForm } from "./DepositForm";

export type SwapMode = "withdraw" | "deposit";

export function SwapCard() {
  const [mode, setMode] = useState<SwapMode>("withdraw");

  return (
    <section
      className="relative w-full max-w-[480px] animate-fade-up"
      aria-label="Swap"
    >
      <div className="pointer-events-none absolute -inset-px -z-10 rounded-[26px] bg-gradient-to-b from-white/[0.04] to-transparent" />
      <div className="rounded-card border border-border bg-surface-elevated/90 p-4 shadow-card backdrop-blur sm:p-5">
        <ModeToggle mode={mode} onChange={setMode} />
        {mode === "withdraw" ? <WithdrawForm /> : <DepositForm />}
        <Footer mode={mode} />
      </div>
    </section>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: SwapMode;
  onChange: (m: SwapMode) => void;
}) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-1 rounded-pill border border-border bg-surface/70 p-1">
      <TabButton
        active={mode === "withdraw"}
        onClick={() => onChange("withdraw")}
        icon={<ArrowUpFromLine size={13} />}
        label="Withdraw"
        sub="pool → any chain"
      />
      <TabButton
        active={mode === "deposit"}
        onClick={() => onChange("deposit")}
        icon={<ArrowDownToLine size={13} />}
        label="Deposit"
        sub="any chain → pool"
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex flex-col items-center justify-center rounded-pill px-3 py-1.5 transition focus-ring ${
        active
          ? "bg-accent/15 text-accent"
          : "text-foreground-muted hover:bg-surface-muted/50 hover:text-foreground"
      }`}
      aria-pressed={active}
    >
      <span className="inline-flex items-center gap-1.5 text-sm font-medium tracking-tight">
        {icon}
        {label}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">
        {sub}
      </span>
    </button>
  );
}

function Footer({ mode }: { mode: SwapMode }) {
  const text =
    mode === "withdraw"
      ? "Anonymized exit · settles via NEAR Intents"
      : "Anonymized entry · routed via NEAR Intents";
  return (
    <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-foreground-subtle">
      <span className="size-1 rounded-full bg-accent" />
      {text}
    </p>
  );
}
