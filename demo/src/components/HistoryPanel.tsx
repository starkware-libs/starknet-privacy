import { useState, useEffect, useRef } from "react";
import type { TransactionDisplay, ActionDisplay } from "../hooks/useHistory.ts";
import { formatTokenAmount, formatRelativeTime } from "../format.ts";

const chipLabel: Record<string, string> = {
  transferReceived: "transfer in",
  transferSelf: "reorganize",
  transferSent: "transfer out",
  fee: "paymaster",
};

function actionChipLabel(action: ActionDisplay): string {
  return action.chipLabel ?? chipLabel[action.type] ?? action.type;
}

type Props = {
  transactions: TransactionDisplay[];
  explorerUrl?: string;
  loading: boolean;
  error: string | null;
  historyComplete: boolean;
  onFetchMore: () => void;
};

export function HistoryPanel({
  transactions,
  explorerUrl,
  loading,
  error,
  historyComplete,
  onFetchMore,
}: Props) {
  const [expandedIndexes, setExpandedIndexes] = useState<Set<number>>(
    new Set(),
  );
  const [glowHashes, setGlowHashes] = useState<Set<string>>(new Set());
  const prevCountRef = useRef(transactions.length);

  useEffect(() => {
    const prevCount = prevCountRef.current;
    prevCountRef.current = transactions.length;
    if (transactions.length > prevCount && prevCount > 0) {
      const newHashes = new Set(
        transactions.slice(0, transactions.length - prevCount).map((tx) => tx.transactionHash),
      );
      setGlowHashes(newHashes);
      const timer = setTimeout(() => setGlowHashes(new Set()), 2000);
      return () => clearTimeout(timer);
    }
  }, [transactions]);

  function toggleExpanded(index: number) {
    setExpandedIndexes((previous) => {
      const next = new Set(previous);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  return (
    <div className="history-section">
      {error && <div className="error">Error: {error}</div>}

      {transactions.length === 0 && !loading && !error && (
        <p className="empty">No history yet</p>
      )}

      {transactions.map((transaction, transactionIndex) => {
        const expanded = expandedIndexes.has(transactionIndex);
        return (
          <div
            key={transactionIndex}
            className={`history-row ${expanded ? "history-row-expanded" : ""} ${glowHashes.has(transaction.transactionHash) ? "glow" : ""}`}
          >
            <div
              className="history-row-summary"
              onClick={() => toggleExpanded(transactionIndex)}
            >
              <span className="history-expand-icon">
                {expanded ? "\u25BC" : "\u25B6"}
              </span>
              {transaction.timestamp != null && (
                <span className="history-field">
                  <span className="history-value history-timestamp">
                    {formatRelativeTime(transaction.timestamp)}
                  </span>
                </span>
              )}
              <span className="history-field">
                <span className="history-label">Block</span>
                <span className="history-value">
                  #{transaction.blockNumber}
                </span>
              </span>
              <span className="history-field">
                <span className="history-label">Tx</span>
                <span className="history-value">
                  {explorerUrl ? (
                    <a
                      href={`${explorerUrl.replace(/\/$/, "")}/tx/${transaction.fullTransactionHash}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {transaction.transactionHash}
                    </a>
                  ) : (
                    transaction.transactionHash
                  )}
                </span>
              </span>
              <span className="history-field history-balance-field">
                {transaction.balanceUpdates.map((update, updateIndex) => (
                  <span
                    key={updateIndex}
                    className={
                      update.amount >= 0n
                        ? "balance-positive"
                        : "balance-negative"
                    }
                  >
                    {update.amount >= 0n ? "+" : "\u2212"}
                    {formatTokenAmount(update.amount < 0n ? -update.amount : update.amount, update.decimals)} {update.tokenName}
                  </span>
                ))}
              </span>
              <span className="history-field history-chips-field">
                {[
                  ...new Set(transaction.actions.map((action) => action.type)),
                ].filter((type) => {
                  if (type !== "withdrawal") return true;
                  const withdrawals = transaction.actions.filter((a) => a.type === "withdrawal");
                  return withdrawals.some((a) => !a.isFee);
                }).map((type) => {
                  const action = transaction.actions.find(
                    (a) => a.type === type,
                  )!;
                  return (
                    <span key={type} className={`chip ${action.chipClass}`}>
                      {actionChipLabel(action)}
                    </span>
                  );
                })}
              </span>
            </div>

            {expanded && (
              <>
                <ul className="history-row-details">
                  {transaction.actions.map((action, actionIndex) => (
                    <li key={actionIndex} className="history-action">
                      {action.label}
                      {action.noteCount !== undefined && (
                        <span className="note-count">
                          {" "}
                          ({action.noteCount}{" "}
                          {action.noteCount === 1 ? "note" : "notes"})
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {explorerUrl && (
                  <a
                    className="explorer-link"
                    href={`${explorerUrl.replace(/\/$/, "")}/tx/${transaction.fullTransactionHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View in explorer ↗
                  </a>
                )}
              </>
            )}
          </div>
        );
      })}

      {loading && <p className="empty">Loading...</p>}

      {!historyComplete && !loading && transactions.length > 0 && (
        <button className="load-more" onClick={onFetchMore}>
          Load More
        </button>
      )}
    </div>
  );
}
