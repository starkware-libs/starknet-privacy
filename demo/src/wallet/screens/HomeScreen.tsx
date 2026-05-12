import { useEffect, useRef, useState } from "react";
import type { AccountConfig, TokenConfig } from "../../config.ts";
import type { PrivateState } from "../../hooks/usePrivateState.ts";
import type { TransactionStatus } from "../../hooks/useTransactions.ts";
import type { PendingStored } from "../../hooks/usePendingStored.ts";
import type { TransactionDisplay, ActionDisplay } from "../../hooks/useHistory.ts";
import { formatRelativeTime, formatTokenAmount } from "../../format.ts";
import { Icon } from "../components/Icon.tsx";
import { TokenAvatar } from "../components/TokenAvatar.tsx";
import { CopyButton } from "../components/CopyButton.tsx";
import { formatAge } from "../useAutoRefresh.ts";
import { detectOtcTrade, leadOtcLabel } from "../wallet-history.ts";
import type { WalletAction } from "../WalletApp.tsx";

type Props = {
  activeAccount: AccountConfig;
  accounts: AccountConfig[];
  activeIndex: number;
  onSelectAccount: (index: number) => void;
  onOpenImport: () => void;

  state: PrivateState;
  tokens: TokenConfig[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  lastRefreshAt: number | null;

  sendCapable: boolean;
  isMainnet: boolean;
  balancesHidden: boolean;
  onToggleHidden: () => void;

  pendingStored: PendingStored[];
  onApplyStored: (entry: PendingStored) => void;
  onDiscardStored: (actionsHash: string) => void;

  status: TransactionStatus;
  onRegister: () => void;
  onMint?: (token: string, amount: string) => void;
  explorerUrl?: string;
  otcAvailable: boolean;
  historyTransactions: TransactionDisplay[];

  onAction: (action: WalletAction) => void;
};

export function HomeScreen({
  activeAccount,
  accounts,
  activeIndex,
  onSelectAccount,
  onOpenImport,
  state,
  tokens,
  loading,
  error,
  onRefresh,
  lastRefreshAt,
  sendCapable,
  isMainnet,
  balancesHidden,
  onToggleHidden,
  pendingStored,
  onApplyStored,
  onDiscardStored,
  status,
  onRegister,
  onMint,
  explorerUrl,
  otcAvailable,
  historyTransactions,
  onAction,
}: Props) {
  // Glow a token row when its balance ticks. Mirrors InfoPanel's behavior so
  // the new wallet has the same "balance just changed" feedback.
  const [glowAddresses, setGlowAddresses] = useState<Set<string>>(new Set());
  const previousBalances = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const changed = new Set<string>();
    for (const tb of state.tokenBalances) {
      const fingerprint = `${tb.private}:${tb.transparent}`;
      const previous = previousBalances.current.get(tb.address);
      if (previous !== undefined && previous !== fingerprint) {
        changed.add(tb.address);
      }
      previousBalances.current.set(tb.address, fingerprint);
    }
    if (changed.size > 0) {
      setGlowAddresses(changed);
      const timer = setTimeout(() => setGlowAddresses(new Set()), 1800);
      return () => clearTimeout(timer);
    }
  }, [state.tokenBalances]);

  const visibleTokens = state.tokenBalances.filter(
    (tb) => tb.private > 0n || tb.transparent > 0n
  );
  const hiddenTokens = state.tokenBalances.filter(
    (tb) => tb.private === 0n && tb.transparent === 0n
  );
  const [showAllTokens, setShowAllTokens] = useState(false);

  // "Total shielded value" — without a price oracle, we can't roll up across
  // tokens, so show the count of tokens with private balance and the highest
  // private balance among them. Keeps the hero meaningful without faking USD.
  const shieldedCount = state.tokenBalances.filter((tb) => tb.private > 0n).length;
  const totalNotes = state.tokenBalances.reduce((sum, tb) => sum + tb.noteCount, 0);

  const nonAdmin = accounts
    .map((account, index) => ({ account, index }))
    .filter((entry) => !entry.account.admin);

  const isRegistered = state.isRegistered === true;
  const needsRegister = state.isRegistered === false;

  return (
    <>
      <div className="top-bar">
        <div>
          <h1 className="page-title">
            Welcome back{activeAccount.name ? `, ${activeAccount.name}` : ""}
          </h1>
          <p className="page-sub">
            Your shielded balances are held inside the privacy pool. Only you can see them.
          </p>
        </div>

        <div className="row">
          <FreshnessIndicator lastRefreshAt={lastRefreshAt} loading={loading} />
          <button className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={loading}>
            <Icon.Refresh size={14} />
            {loading ? "Refreshing" : "Refresh"}
          </button>

          {nonAdmin.length > 1 ? (
            <label className="acc-chip" style={{ cursor: "pointer" }}>
              <div className="acc-avatar">{initials(activeAccount.name)}</div>
              <select
                style={{
                  background: "none",
                  border: "none",
                  outline: "none",
                  color: "inherit",
                  font: "inherit",
                  cursor: "pointer",
                  appearance: "none",
                  padding: "0 18px 0 0",
                }}
                value={activeIndex}
                onChange={(event) => onSelectAccount(Number(event.target.value))}
              >
                {nonAdmin.map((entry) => (
                  <option key={entry.account.address} value={entry.index}>
                    {entry.account.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="acc-chip">
              <div className="acc-avatar">{initials(activeAccount.name)}</div>
              <div className="acc-chip-meta">
                <span className="acc-name">{activeAccount.name}</span>
                <span className="acc-addr">
                  {activeAccount.address.slice(0, 8)}…{activeAccount.address.slice(-4)}
                </span>
              </div>
            </div>
          )}

          <button
            className="btn btn-ghost btn-sm"
            onClick={onOpenImport}
            title="Add another account"
          >
            <Icon.Plus size={14} />
            Add
          </button>
        </div>
      </div>

      {error && (
        <div
          className="card"
          style={{
            marginBottom: 18,
            borderColor: "rgba(248, 113, 113, 0.32)",
            background: "rgba(248, 113, 113, 0.06)",
          }}
        >
          <div style={{ color: "var(--danger)", fontWeight: 600, marginBottom: 4 }}>
            Discovery error
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {error}
          </div>
        </div>
      )}

      {!isRegistered && (
        <div
          className="card"
          style={{
            marginBottom: 18,
            display: "flex",
            alignItems: "center",
            gap: 16,
            borderColor: needsRegister ? "rgba(251, 191, 36, 0.32)" : "var(--card-border)",
            background: needsRegister ? "rgba(251, 191, 36, 0.06)" : "var(--card)",
          }}
        >
          <div style={{ width: 36, height: 36, borderRadius: 12, background: "var(--accent-grad-soft)", display: "grid", placeItems: "center", color: "var(--warning)" }}>
            <Icon.Shield />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>
              {state.isRegistered === null ? "Checking registration…" : "Register with the privacy pool"}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {state.isRegistered === null
                ? "Verifying account state on chain."
                : "Registering publishes your public key so others can send you shielded tokens."}
            </div>
          </div>
          {needsRegister && (
            <button
              className="btn btn-primary"
              onClick={onRegister}
              disabled={status.pending || !sendCapable}
              title={!sendCapable ? "View-only account" : undefined}
            >
              {status.pending && status.action === "Register" && <span className="spinner" />}
              Register
            </button>
          )}
        </div>
      )}

      <div className="hero">
        <div className="hero-label">
          <Icon.Shield size={14} />
          Shielded wallet
          <span className="muted" style={{ fontSize: 11, fontWeight: 500, letterSpacing: 0 }}>
            {balancesHidden
              ? "•••"
              : `${shieldedCount} ${shieldedCount === 1 ? "asset" : "assets"} · ${totalNotes} ${totalNotes === 1 ? "note" : "notes"}`}
          </span>
          <div className="spacer" />
          <button className="eye-btn" onClick={onToggleHidden} aria-label="Toggle visibility">
            {balancesHidden ? <Icon.EyeOff size={14} /> : <Icon.Eye size={14} />}
          </button>
        </div>

        <LatestActivity
          transactions={historyTransactions}
          explorerUrl={explorerUrl}
          balancesHidden={balancesHidden}
          activeAddressLabel={activeAccount.name}
        />

        <div className={`qa-row hero-actions${otcAvailable ? " qa-row-otc" : ""}`}>
          {/* When OTC is available, the four regular actions live inside a
              2×2 sub-grid; when not, they flow into the parent .qa-row's
              auto-fit grid via `display: contents`. */}
          <div
            className={otcAvailable ? "qa-grid" : ""}
            style={otcAvailable ? undefined : { display: "contents" }}
          >
            <QuickAction
              label="Send"
              icon={<Icon.ArrowUpRight size={14} />}
              onClick={() => onAction({ kind: "send" })}
              disabled={!sendCapable || !isRegistered}
              title={
                !sendCapable
                  ? "View-only — import a private key"
                  : !isRegistered
                    ? "Register first"
                    : undefined
              }
            />
            <QuickAction
              label="Receive"
              icon={<Icon.ArrowDownLeft size={14} />}
              onClick={() => onAction({ kind: "receive" })}
            />
            <QuickAction
              label="Deposit"
              icon={<Icon.Plus size={14} />}
              onClick={() => onAction({ kind: "deposit" })}
              disabled={!sendCapable}
            />
            <QuickAction
              label="Withdraw"
              icon={<Icon.Minus size={14} />}
              onClick={() => onAction({ kind: "withdraw" })}
              disabled={!sendCapable || !isRegistered}
              title={!isRegistered ? "Register first" : undefined}
            />
          </div>
          {otcAvailable && (
            <QuickAction
              label="OTC trade"
              icon={<Icon.Handshake size={24} />}
              onClick={() => onAction({ kind: "otc" })}
              disabled={!sendCapable || !isRegistered}
              title={!isRegistered ? "Register first" : "Atomic peer-to-peer swaps"}
              shiny
              badge="New"
              big
            />
          )}
        </div>
      </div>

      {pendingStored.length > 0 && (
        <div className="stack" style={{ marginTop: 18 }}>
          {pendingStored.map((entry) => (
            <div className="pending-mini" key={entry.actionsHash}>
              <div className="pending-mini-row">
                <div>
                  <div style={{ fontWeight: 600 }}>{entry.label}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    Stored — apply when ready.{" "}
                    {explorerUrl && (
                      <a
                        href={`${explorerUrl}/tx/${entry.storeTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        store tx ↗
                      </a>
                    )}
                  </div>
                </div>
                <div className="row">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => onApplyStored(entry)}
                    disabled={status.pending}
                  >
                    Apply
                  </button>
                  <button
                    className="btn btn-quiet btn-sm"
                    onClick={() => onDiscardStored(entry.actionsHash)}
                    title="Discard from local cache"
                  >
                    Discard
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 18 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <h3 className="card-title" style={{ margin: 0 }}>
            Tokens
          </h3>
          <div className="spacer" />
          {onMint && !isMainnet && (
            <MintInline tokens={tokens} pending={status.pending} action={status.action} onMint={onMint} />
          )}
        </div>

        <div className="token-list">
          {visibleTokens.length === 0 && hiddenTokens.length === 0 && (
            <div className="empty">No tokens discovered yet.</div>
          )}
          {visibleTokens.map((tb) => (
            <TokenRow
              key={tb.address}
              name={tb.name}
              address={tb.address}
              decimals={tb.decimals}
              privateBalance={tb.private}
              transparentBalance={tb.transparent}
              noteCount={tb.noteCount}
              isFee={tb.fee}
              hidden={balancesHidden}
              glow={glowAddresses.has(tb.address)}
            />
          ))}
          {hiddenTokens.length > 0 && !showAllTokens && (
            <button
              className="btn btn-quiet btn-sm"
              onClick={() => setShowAllTokens(true)}
              style={{ alignSelf: "flex-start", marginTop: 6 }}
            >
              Show {hiddenTokens.length} more
            </button>
          )}
          {hiddenTokens.length > 0 &&
            showAllTokens &&
            hiddenTokens.map((tb) => (
              <TokenRow
                key={tb.address}
                name={tb.name}
                address={tb.address}
                decimals={tb.decimals}
                privateBalance={tb.private}
                transparentBalance={tb.transparent}
                noteCount={tb.noteCount}
                isFee={tb.fee}
                hidden={balancesHidden}
                glow={glowAddresses.has(tb.address)}
              />
            ))}
        </div>
      </div>
    </>
  );
}

function QuickAction({
  label,
  icon,
  onClick,
  disabled,
  title,
  shiny,
  badge,
  big,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  shiny?: boolean;
  badge?: string;
  big?: boolean;
}) {
  return (
    <button
      className={`qa${shiny ? " qa-shiny" : ""}${big ? " qa-otc-big" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {badge && <span className="qa-new-badge">{badge}</span>}
      <div className="qa-icon">{icon}</div>
      {label}
    </button>
  );
}

function TokenRow({
  name,
  address,
  decimals,
  privateBalance,
  transparentBalance,
  noteCount,
  isFee,
  hidden,
  glow,
}: {
  name: string;
  address: string;
  decimals: number;
  privateBalance: bigint;
  transparentBalance: bigint;
  noteCount: number;
  isFee: boolean;
  hidden: boolean;
  glow: boolean;
}) {
  return (
    <div className={`token-row${glow ? " glow" : ""}`}>
      <TokenAvatar name={name} />
      <div>
        <div className="token-name">
          {name}
          {isFee && (
            <span className="chip" style={{ marginLeft: 8 }}>
              fee token
            </span>
          )}
        </div>
        <div className="token-sub">
          <span className="mono">{address.slice(0, 8)}…{address.slice(-4)}</span>
          <CopyButton value={address} inline />
          {noteCount > 0 && <span className="chip">{noteCount} notes</span>}
        </div>
      </div>
      <div className="token-amt tabular">
        <div className="token-amt-private">
          {hidden ? "•••" : formatTokenAmount(privateBalance, decimals)}{" "}
          <span className="chip chip-private" style={{ marginLeft: 4 }}>
            private
          </span>
        </div>
        <div className="token-amt-public">
          {hidden ? "•••" : formatTokenAmount(transparentBalance, decimals)} public
        </div>
      </div>
    </div>
  );
}

function MintInline({
  tokens,
  pending,
  action,
  onMint,
}: {
  tokens: TokenConfig[];
  pending: boolean;
  action: string | null;
  onMint: (token: string, amount: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(tokens[0]?.address ?? "");
  const [amount, setAmount] = useState("100");
  if (!open) {
    return (
      <button className="btn btn-quiet btn-sm" onClick={() => setOpen(true)}>
        <Icon.Sparkle size={13} />
        Mint test tokens
      </button>
    );
  }
  return (
    <div className="row" style={{ gap: 6 }}>
      <select
        value={token}
        onChange={(event) => setToken(event.target.value)}
        style={{
          background: "rgba(0,0,0,0.25)",
          border: "1px solid var(--card-border)",
          color: "var(--text)",
          borderRadius: 8,
          padding: "6px 8px",
          font: "inherit",
        }}
      >
        {tokens.map((tokenConfig) => (
          <option key={tokenConfig.address} value={tokenConfig.address}>
            {tokenConfig.name}
          </option>
        ))}
      </select>
      <input
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        style={{
          background: "rgba(0,0,0,0.25)",
          border: "1px solid var(--card-border)",
          color: "var(--text)",
          borderRadius: 8,
          padding: "6px 8px",
          width: 80,
          font: "inherit",
        }}
      />
      <button
        className="btn btn-primary btn-sm"
        onClick={() => onMint(token, amount)}
        disabled={pending}
      >
        {pending && action === "Mint" && <span className="spinner" />}
        Mint
      </button>
      <button className="btn btn-quiet btn-sm" onClick={() => setOpen(false)}>
        <Icon.X size={13} />
      </button>
    </div>
  );
}

// Hero's primary content: a glimpse of the most recent on-chain activity for
// this account. Renders the same lead-action heuristic used in ActivityScreen
// so the home preview and the activity tab agree on what's "the headline".
// Falls back to a deposit CTA on a fresh account (no history yet).
function LatestActivity({
  transactions,
  explorerUrl,
  balancesHidden,
  activeAddressLabel,
}: {
  transactions: TransactionDisplay[];
  explorerUrl?: string;
  balancesHidden: boolean;
  activeAddressLabel?: string;
}) {
  if (transactions.length === 0) {
    return (
      <div style={{ paddingTop: 18, paddingBottom: 4 }}>
        <div
          style={{
            fontSize: 28,
            fontWeight: 800,
            letterSpacing: "-0.01em",
            marginBottom: 6,
            background: "var(--accent-grad)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          Hey{activeAddressLabel ? `, ${activeAddressLabel}` : ""} 👋
        </div>
        <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 460 }}>
          Welcome to your private wallet. Deposit a token to start moving funds
          privately — only you can see your balances and activity.
        </div>
      </div>
    );
  }

  const transaction = transactions[0];
  const otc = detectOtcTrade(transaction);
  const lead = otc
    ? ({ type: "otcTrade", label: leadOtcLabel(otc) } as const)
    : pickLead(transaction.actions);
  const iconBits = activityIconClass(lead.type);
  // Show outgoing first (red), then incoming (green). For a swap or OTC trade
  // both sides are present and we want the user to see both deltas at once.
  // For simple transfers only one side is non-zero so the second row is hidden.
  const sortedUpdates = [...transaction.balanceUpdates].sort((a, b) => {
    if (a.amount < 0n && b.amount >= 0n) return -1;
    if (b.amount < 0n && a.amount >= 0n) return 1;
    return 0;
  });

  return (
    <div
      style={{
        marginTop: 18,
        padding: "14px 16px",
        borderRadius: 16,
        background: "rgba(255, 255, 255, 0.04)",
        boxShadow: "inset 0 0 0 1px var(--card-border)",
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        gap: 14,
        alignItems: "center",
      }}
    >
      <div className={`activity-icon ${iconBits.wrap}`} style={{ width: 44, height: 44 }}>
        {iconBits.element}
      </div>
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, marginBottom: 4 }}>
          Latest activity
        </div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: "-0.01em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={lead.label}
        >
          {balancesHidden ? "•••" : lead.label}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
          {transaction.timestamp != null && formatRelativeTime(transaction.timestamp)}
          <span className="mono" style={{ marginLeft: 8 }}>
            #{transaction.blockNumber}
          </span>
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        {!balancesHidden &&
          sortedUpdates.slice(0, 2).map((update, updateIndex) => {
            const positive = update.amount >= 0n;
            const magnitude = positive ? update.amount : -update.amount;
            return (
              <div
                key={updateIndex}
                className={`activity-amount ${positive ? "down" : "up"}`}
                style={{ fontSize: 15 }}
              >
                {positive ? "+" : "−"}
                {formatTokenAmount(magnitude, update.decimals)} {update.tokenName}
              </div>
            );
          })}
        {explorerUrl && (
          <a
            href={`${explorerUrl.replace(/\/$/, "")}/tx/${transaction.fullTransactionHash}`}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 11, color: "var(--accent-3)" }}
          >
            View ↗
          </a>
        )}
      </div>
    </div>
  );
}

// Mirror of ActivityScreen's lead picker — kept here as a small inlined copy
// rather than exported so each screen owns its own priority list.
function pickLead(actions: ActionDisplay[]): ActionDisplay {
  const priority: ActionDisplay["type"][] = [
    "transferReceived",
    "swap",
    "deposit",
    "withdrawal",
    "transferSent",
    "transferSelf",
    "register",
    "fee",
  ];
  for (const type of priority) {
    const match = actions.find((a) => a.type === type && !a.isFee);
    if (match) return match;
  }
  return actions[0];
}

// "otcTrade" is a wallet-only synthetic; everything else is the SDK type.
type DisplayActionType = ActionDisplay["type"] | "otcTrade";

function activityIconClass(type: DisplayActionType): { wrap: string; element: React.ReactNode } {
  switch (type) {
    case "transferReceived":
    case "deposit":
      return { wrap: "down", element: <Icon.ArrowDownLeft size={18} /> };
    case "transferSent":
    case "withdrawal":
      return { wrap: "up", element: <Icon.ArrowUpRight size={18} /> };
    case "swap":
      return { wrap: "swap", element: <Icon.Shuffle size={18} /> };
    case "otcTrade":
      return { wrap: "otc", element: <Icon.Handshake size={18} /> };
    case "register":
      return { wrap: "", element: <Icon.Shield size={18} /> };
    case "transferSelf":
      return { wrap: "", element: <Icon.Refresh size={18} /> };
    case "fee":
      return { wrap: "", element: <Icon.Sparkle size={18} /> };
  }
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// "Updated 4s ago" indicator. Ticks once a second so the relative-time label
// stays live even when no other state changes — without that, the user has
// no visible signal that polling is happening.
function FreshnessIndicator({
  lastRefreshAt,
  loading,
}: {
  lastRefreshAt: number | null;
  loading: boolean;
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const intervalId = window.setInterval(() => force((tick) => tick + 1), 1000);
    return () => window.clearInterval(intervalId);
  }, []);
  if (loading) {
    return (
      <span className="muted" style={{ fontSize: 12, marginRight: 4 }}>
        <span className="spinner" style={{ marginRight: 6 }} />
        Refreshing…
      </span>
    );
  }
  return (
    <span
      className="muted"
      style={{ fontSize: 12, marginRight: 4 }}
      title="Auto-refresh every 20s. Pauses when the tab is hidden or a transaction is in flight."
    >
      <span
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: lastRefreshAt === null ? "var(--text-muted)" : "var(--success)",
          marginRight: 6,
          boxShadow: lastRefreshAt === null ? undefined : "0 0 6px var(--success)",
        }}
      />
      Updated {formatAge(lastRefreshAt)}
    </span>
  );
}
