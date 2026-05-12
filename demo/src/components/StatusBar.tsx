import { useState } from "react";
import type { TransactionStatus } from "../hooks/useTransactions.ts";
import { TimelinePopup } from "./TimelinePopup.tsx";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-copy-button"
      title={copied ? "Copied!" : "Copy full error"}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "\u2713" : "\u29C9"}
    </button>
  );
}

function formatProofSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

type Props = {
  status: TransactionStatus;
  explorerUrl?: string;
};

export function StatusBar({ status, explorerUrl }: Props) {
  const [showTimeline, setShowTimeline] = useState(false);

  if (!status.pending && !status.lastTxHash && !status.lastError) return null;

  return (
    <div className="status-bar">
      {status.pending && <span className="pending">{status.action ?? "Transaction"}...</span>}
      {status.lastTxHash && (
        <span className="success">
          Tx:{" "}
          {explorerUrl ? (
            <a
              href={`${explorerUrl.replace(/\/$/, "")}/tx/${status.lastTxHash}`}
              target="_blank"
              rel="noreferrer"
            >
              <code>{status.lastTxHash}</code>
            </a>
          ) : (
            <code>{status.lastTxHash}</code>
          )}
          {status.proofSizeBytes != null && (
            <span className="proof-size">Proof: {formatProofSize(status.proofSizeBytes)}</span>
          )}
        </span>
      )}
      {status.lastError && (
        <span className="error">
          Error <CopyButton value={status.lastError} />
          <code className="status-error-detail">{status.lastError}</code>
        </span>
      )}
      {status.timeline && (
        <button
          className="pool-action-button timeline-button"
          onClick={() => setShowTimeline(true)}
        >
          Timeline
        </button>
      )}
      {showTimeline && status.timeline && (
        <TimelinePopup timeline={status.timeline} onClose={() => setShowTimeline(false)} />
      )}
    </div>
  );
}
