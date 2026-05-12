import { useEffect, useRef, useState } from "react";
import type { TransactionStatus } from "../../hooks/useTransactions.ts";
import { Icon } from "../components/Icon.tsx";

type ToastEntry =
  | { id: number; kind: "ok"; title: string; body: string; href?: string }
  | { id: number; kind: "bad"; title: string; body: string };

type Props = {
  status: TransactionStatus;
  explorerUrl?: string;
};

let toastId = 0;

export function Toast({ status, explorerUrl }: Props) {
  const [entries, setEntries] = useState<ToastEntry[]>([]);
  const previousPending = useRef(false);

  useEffect(() => {
    // Edge transitions: pending true→false. Decide success vs error from the
    // resulting hash/error fields. Skip the very first render when both are
    // null and pending is false (initial mount).
    if (previousPending.current && !status.pending) {
      const id = toastId++;
      if (status.lastError) {
        const entry: ToastEntry = {
          id,
          kind: "bad",
          title: "Transaction failed",
          body: status.lastError,
        };
        setEntries((previous) => [...previous, entry]);
        setTimeout(() => dismiss(id), 6000);
      } else if (status.lastTxHash) {
        const href = explorerUrl
          ? `${explorerUrl.replace(/\/$/, "")}/tx/${status.lastTxHash}`
          : undefined;
        const entry: ToastEntry = {
          id,
          kind: "ok",
          title: status.action ? `${status.action} confirmed` : "Confirmed",
          body: `${status.lastTxHash.slice(0, 12)}…${status.lastTxHash.slice(-8)}`,
          href,
        };
        setEntries((previous) => [...previous, entry]);
        setTimeout(() => dismiss(id), 4500);
      }
    }
    previousPending.current = status.pending;
  }, [status.pending, status.lastError, status.lastTxHash, status.action, explorerUrl]);

  function dismiss(id: number) {
    setEntries((previous) => previous.filter((entry) => entry.id !== id));
  }

  if (entries.length === 0 && !status.pending) return null;

  return (
    <div className="toast">
      {status.pending && (
        <div className="toast-item">
          <span className="spinner" style={{ marginTop: 2 }} />
          <div style={{ flex: 1 }}>
            <div className="toast-title">{status.action ?? "Working"}</div>
            <div className="toast-body">Building proof and submitting on chain…</div>
          </div>
        </div>
      )}
      {entries.map((entry) => (
        <div key={entry.id} className={`toast-item ${entry.kind}`}>
          <div style={{ marginTop: 2, color: entry.kind === "ok" ? "var(--success)" : "var(--danger)" }}>
            {entry.kind === "ok" ? <Icon.Check size={16} /> : <Icon.X size={16} />}
          </div>
          <div style={{ flex: 1 }}>
            <div className="toast-title">{entry.title}</div>
            <div className="toast-body mono">
              {entry.kind === "ok" && entry.href ? (
                <a href={entry.href} target="_blank" rel="noreferrer">
                  {entry.body} ↗
                </a>
              ) : (
                entry.body
              )}
            </div>
          </div>
          <button className="toast-close" onClick={() => dismiss(entry.id)}>
            <Icon.X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
