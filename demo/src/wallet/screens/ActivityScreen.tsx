import { useState } from "react";
import type { TransactionDisplay, ActionDisplay } from "../../hooks/useHistory.ts";
import { formatRelativeTime, formatTokenAmount } from "../../format.ts";
import { Icon } from "../components/Icon.tsx";
import { detectOtcTrade, leadOtcLabel } from "../wallet-history.ts";

type Props = {
  transactions: TransactionDisplay[];
  explorerUrl?: string;
  loading: boolean;
  error: string | null;
  historyComplete: boolean;
  onFetchMore: () => void;
};

// "otcTrade" is a wallet-side synthetic — see wallet-history.ts. Everything
// else passes through from the SDK classifier unchanged.
type DisplayActionType = ActionDisplay["type"] | "otcTrade";

const TYPE_LABEL: Record<DisplayActionType, string> = {
  deposit: "Deposit",
  withdrawal: "Withdraw",
  transferSent: "Sent",
  transferReceived: "Received",
  transferSelf: "Reorganize",
  swap: "Swap",
  register: "Register",
  fee: "Paymaster fee",
  otcTrade: "OTC trade",
};

function leadAction(actions: ActionDisplay[]): ActionDisplay {
  // Prefer transferReceived > swap > deposit > withdrawal > transferSent > others
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

function activityIconClass(type: DisplayActionType): { wrap: string; element: React.ReactNode } {
  switch (type) {
    case "transferReceived":
    case "deposit":
      return { wrap: "down", element: <Icon.ArrowDownLeft size={16} /> };
    case "transferSent":
    case "withdrawal":
      return { wrap: "up", element: <Icon.ArrowUpRight size={16} /> };
    case "swap":
      return { wrap: "swap", element: <Icon.Shuffle size={16} /> };
    case "otcTrade":
      return { wrap: "otc", element: <Icon.Handshake size={16} /> };
    case "register":
      return { wrap: "", element: <Icon.Shield size={16} /> };
    case "transferSelf":
      return { wrap: "", element: <Icon.Refresh size={16} /> };
    case "fee":
      return { wrap: "", element: <Icon.Sparkle size={16} /> };
  }
}

export function ActivityScreen({
  transactions,
  explorerUrl,
  loading,
  error,
  historyComplete,
  onFetchMore,
}: Props) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  function toggle(index: number) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <>
      <div className="top-bar">
        <div>
          <h1 className="page-title">Activity</h1>
          <p className="page-sub">
            Every action you've taken in the pool. Only your viewing key can decrypt it.
          </p>
        </div>
        {loading && <span className="chip"><span className="spinner" /> Loading</span>}
      </div>

      {error && (
        <div
          className="card"
          style={{
            marginBottom: 18,
            borderColor: "rgba(248, 113, 113, 0.32)",
            background: "rgba(248, 113, 113, 0.06)",
            color: "var(--danger)",
          }}
        >
          {error}
        </div>
      )}

      <div className="card">
        {transactions.length === 0 && !loading && !error && (
          <div className="empty">No activity yet. Deposit to get started.</div>
        )}

        {transactions.map((transaction, transactionIndex) => {
          const otc = detectOtcTrade(transaction);
          // When OTC is detected, the synthetic "otcTrade" type drives the
          // icon + label and replaces the "Received +N" header that came from
          // the SDK's separate transferSent/transferReceived classification.
          const leadType: DisplayActionType = otc ? "otcTrade" : leadAction(transaction.actions).type;
          const iconBits = activityIconClass(leadType);
          const headerLabel = otc ? leadOtcLabel(otc) : TYPE_LABEL[leadType];
          // For OTC trades the count chip is meaningless ("trade with X +1" is
          // confusing because the +1 is the other leg we've already folded in).
          const showExtraCount = !otc && transaction.actions.length > 1;
          const isOpen = expanded.has(transactionIndex);
          return (
            <div key={transactionIndex}>
              <button
                className="activity-row"
                onClick={() => toggle(transactionIndex)}
                style={{
                  width: "100%",
                  background: "none",
                  border: "none",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <div className={`activity-icon ${iconBits.wrap}`}>{iconBits.element}</div>
                <div className="activity-main">
                  <div className="activity-title">
                    {headerLabel}
                    {otc && (
                      <span
                        className="chip"
                        style={{
                          marginLeft: 8,
                          background: "var(--accent-grad-soft)",
                          color: "var(--text)",
                          boxShadow: "inset 0 0 0 1px rgba(244, 114, 182, 0.42)",
                        }}
                      >
                        OTC
                      </span>
                    )}
                    {showExtraCount && (
                      <span className="chip" style={{ marginLeft: 8 }}>
                        +{transaction.actions.length - 1}
                      </span>
                    )}
                  </div>
                  <div className="activity-sub">
                    {transaction.timestamp != null && (
                      <span>{formatRelativeTime(transaction.timestamp)}</span>
                    )}
                    <span className="mono">#{transaction.blockNumber}</span>
                  </div>
                </div>
                <div className="tabular" style={{ textAlign: "right" }}>
                  {transaction.balanceUpdates.length === 0 && (
                    <span className="muted" style={{ fontSize: 12 }}>
                      —
                    </span>
                  )}
                  {[...transaction.balanceUpdates]
                    .sort((a, b) => {
                      // Outgoing (red) first, then incoming (green) — keeps
                      // the eye reading "I sent X, I got Y" for swap/OTC.
                      if (a.amount < 0n && b.amount >= 0n) return -1;
                      if (b.amount < 0n && a.amount >= 0n) return 1;
                      return 0;
                    })
                    .slice(0, 2)
                    .map((update, updateIndex) => {
                    const positive = update.amount >= 0n;
                    const magnitude = positive ? update.amount : -update.amount;
                    return (
                      <div
                        key={updateIndex}
                        className={`activity-amount ${positive ? "down" : "up"}`}
                        style={{ fontSize: 13 }}
                      >
                        {positive ? "+" : "−"}
                        {formatTokenAmount(magnitude, update.decimals)} {update.tokenName}
                      </div>
                    );
                  })}
                </div>
              </button>
              {isOpen && (
                <div
                  style={{
                    padding: "8px 14px 18px 64px",
                    fontSize: 13,
                    color: "var(--text-dim)",
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                  }}
                >
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {transaction.actions.map((action, actionIndex) => (
                      <li key={actionIndex} style={{ marginBottom: 4 }}>
                        {action.label}
                      </li>
                    ))}
                  </ul>
                  {explorerUrl && (
                    <a
                      href={`${explorerUrl.replace(/\/$/, "")}/tx/${transaction.fullTransactionHash}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: "inline-block", marginTop: 8, fontSize: 12 }}
                    >
                      View on explorer ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {!historyComplete && !loading && transactions.length > 0 && (
          <div style={{ paddingTop: 16, display: "grid", placeItems: "center" }}>
            <button className="btn btn-ghost btn-sm" onClick={onFetchMore}>
              Load more
            </button>
          </div>
        )}
      </div>
    </>
  );
}
