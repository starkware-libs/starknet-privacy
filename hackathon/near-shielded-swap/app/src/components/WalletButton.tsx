import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  LogOut,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useWallet, type IdentityStatus } from "../hooks/useWallet";
import { addressUrl, truncateAddress } from "../lib/chain";
import { publicKeyFingerprint } from "../lib/identity";

export function WalletButton() {
  const {
    status,
    identity,
    connectWallet,
    cancelConnect,
    disconnectWallet,
    setupIdentity,
  } = useWallet();

  if (status.kind === "connected") {
    return (
      <ConnectedPill
        address={status.address}
        walletName={status.walletName}
        identity={identity}
        onSetupIdentity={setupIdentity}
        onDisconnect={disconnectWallet}
      />
    );
  }

  const isConnecting = status.kind === "connecting";

  return (
    <button
      type="button"
      // While connecting, the click cancels — gives the user an escape hatch
      // if starknetkit's modal got dismissed or lost.
      onClick={isConnecting ? cancelConnect : connectWallet}
      className="rounded-pill border border-accent/40 bg-accent/10 px-4 py-1.5 text-sm font-medium text-accent transition hover:border-accent/60 hover:bg-accent/15 focus-ring"
      title={isConnecting ? "Click to cancel" : "Connect Starknet wallet"}
    >
      <span className="inline-flex items-center gap-2">
        {isConnecting ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Wallet size={14} />
        )}
        {isConnecting ? "Connecting… (cancel)" : "Connect Wallet"}
      </span>
    </button>
  );
}

function ConnectedPill({
  address,
  walletName,
  identity,
  onSetupIdentity,
  onDisconnect,
}: {
  address: string;
  walletName: string;
  identity: IdentityStatus;
  onSetupIdentity: () => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
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
        className="group inline-flex items-center gap-2 rounded-pill border border-border-strong bg-surface-elevated px-3 py-1.5 text-sm transition hover:border-accent/40 focus-ring"
      >
        <span className="relative flex size-2">
          <span className="absolute inset-0 animate-pulse-dot rounded-full bg-accent/70" />
          <span className="relative inline-block size-2 rounded-full bg-accent" />
        </span>
        <IdentityBadge identity={identity} />
        <span className="font-mono text-xs tabular-nums text-foreground">
          {truncateAddress(address)}
        </span>
      </button>

      {open ? (
        <div className="absolute right-0 z-30 mt-2 w-72 origin-top-right animate-fade-up rounded-card border border-border-strong bg-surface-elevated p-2 shadow-card">
          <div className="px-3 pb-2 pt-1">
            <div className="text-[10px] uppercase tracking-[0.18em] text-foreground-subtle">
              Connected via {walletName}
            </div>
            <div className="mt-1 font-mono text-xs tabular-nums text-foreground">
              {truncateAddress(address, 10, 8)}
            </div>
          </div>
          <IdentitySection identity={identity} onSetup={onSetupIdentity} />
          <div className="my-1 h-px bg-border" />
          <MenuItem
            icon={copied ? <CheckCircle2 size={14} className="text-accent" /> : <Copy size={14} />}
            label={copied ? "Copied" : "Copy address"}
            onClick={async () => {
              await navigator.clipboard.writeText(address);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
          />
          <MenuItem
            icon={<ExternalLink size={14} />}
            label="View on Voyager"
            href={addressUrl(address)}
          />
          <MenuItem
            icon={<LogOut size={14} />}
            label="Disconnect"
            tone="danger"
            onClick={async () => {
              await onDisconnect();
              setOpen(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function IdentityBadge({ identity }: { identity: IdentityStatus }) {
  if (identity.kind === "ready") {
    return (
      <span
        title="Shielded identity ready"
        className="inline-flex size-4 items-center justify-center rounded-full bg-accent/15 text-accent"
      >
        <ShieldCheck size={11} />
      </span>
    );
  }
  if (identity.kind === "deriving") {
    return (
      <span
        title="Deriving shielded identity"
        className="inline-flex size-4 items-center justify-center rounded-full bg-foreground-subtle/10 text-foreground-muted"
      >
        <Loader2 size={11} className="animate-spin" />
      </span>
    );
  }
  if (identity.kind === "rejected" || identity.kind === "error") {
    return (
      <span
        title="Shielded identity not set up"
        className="inline-flex size-4 items-center justify-center rounded-full bg-danger/15 text-danger"
      >
        <AlertTriangle size={10} />
      </span>
    );
  }
  return null;
}

function IdentitySection({
  identity,
  onSetup,
}: {
  identity: IdentityStatus;
  onSetup: () => Promise<void>;
}) {
  if (identity.kind === "ready") {
    return (
      <div className="my-1 rounded-xl border border-border bg-pool-ink/40 px-3 py-2">
        <div className="text-[10px] uppercase tracking-[0.18em] text-accent">
          Shielded identity
        </div>
        <div className="mt-0.5 font-mono text-xs tabular-nums text-foreground">
          {publicKeyFingerprint(identity.identity)}
        </div>
        <div className="mt-1 text-[10px] text-foreground-subtle">
          Re-derived deterministically each session — never stored.
        </div>
      </div>
    );
  }
  if (identity.kind === "deriving") {
    return (
      <div className="my-1 flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs text-foreground-muted">
        <Loader2 size={12} className="animate-spin text-accent" />
        Awaiting signature in your wallet…
      </div>
    );
  }
  // none | rejected | error
  const label =
    identity.kind === "rejected"
      ? "Signature was rejected"
      : identity.kind === "error"
        ? "Couldn't derive identity"
        : "Set up shielded identity";
  return (
    <button
      type="button"
      onClick={onSetup}
      className="my-1 flex w-full items-center justify-between gap-2 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent transition hover:bg-accent/15"
    >
      <span className="inline-flex items-center gap-2">
        <ShieldCheck size={12} />
        {label}
      </span>
      <span className="text-[10px] uppercase tracking-wider opacity-80">
        Sign
      </span>
    </button>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  href,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  href?: string;
  tone?: "danger";
}) {
  const classes = `flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition hover:bg-surface-muted ${
    tone === "danger" ? "text-danger" : "text-foreground"
  }`;
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={classes}>
        {icon}
        <span>{label}</span>
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={classes}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
