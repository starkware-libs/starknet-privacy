import { useState, useEffect, useCallback, useMemo } from "react";
import type { TransactionStatus } from "../hooks/useTransactions.ts";
import { TimelinePopup } from "./TimelinePopup.tsx";

function formatProofSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const MAX_SHORT_LENGTH = 200;

type ParsedError = {
  /** Human-readable summary line */
  summary: string;
  /** Transaction hash if available */
  txHash?: string;
  /** Revert reason from the receipt */
  revertReason?: string;
  /** Whether we successfully parsed structured info */
  structured: boolean;
};

function parseError(raw: string): ParsedError {
  // Try to parse "Action: Transaction reverted: {json...}" pattern
  const revertedMatch = raw.match(/^(.+?): Transaction reverted: (\{.+\})$/s);
  if (revertedMatch) {
    try {
      const receipt = JSON.parse(revertedMatch[2]);
      const revertReason = receipt.revert_reason as string | undefined;
      // Extract the short reason from the revert string
      // Pattern: "...\n0xHEX ('Human readable').\n"
      let shortReason: string | undefined;
      if (revertReason) {
        const reasonMatch = revertReason.match(/\('([^']+)'\)/);
        shortReason = reasonMatch?.[1];
        // Also check for simple messages like "Insufficient max L1DataGas..."
        if (!shortReason) {
          const lastLine = revertReason.trim().split("\n").pop()?.trim();
          if (lastLine && !lastLine.startsWith("0:") && !lastLine.startsWith("Error in")) {
            shortReason = lastLine;
          }
        }
      }
      return {
        summary: shortReason ?? revertReason?.slice(0, 120) ?? "Transaction reverted",
        txHash: receipt.transaction_hash as string | undefined,
        revertReason: revertReason,
        structured: true,
      };
    } catch {
      // JSON parse failed, fall through
    }
  }

  // Try to parse "Action: Proving service error (code X) ..." pattern
  const provingMatch = raw.match(
    /^(.+?): Proving service error \(code (-?\d+)\)\s+(.+)$/s
  );
  if (provingMatch) {
    const detail = provingMatch[3];
    // Try to extract inner JSON-RPC error
    const jsonRpcMatch = detail.match(/message="([^"]+)"/);
    const dataMatch = detail.match(/data=(\{[^}]+\})/);
    let summary = jsonRpcMatch?.[1] ?? detail.slice(0, 120);
    if (dataMatch) {
      try {
        const data = JSON.parse(dataMatch[1]);
        if (data.limit !== undefined && data.requested !== undefined) {
          summary += ` (limit: ${data.limit}, requested: ${data.requested})`;
        }
      } catch {
        // ignore
      }
    }
    return { summary, structured: true };
  }

  return { summary: raw, structured: false };
}

type Props = {
  status: TransactionStatus;
};

export function StatusBar({ status }: Props) {
  const [showTimeline, setShowTimeline] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setDismissed(false);
    setCopied(false);
    setExpanded(false);
  }, [status.pending, status.lastTxHash, status.lastError]);

  const copyError = useCallback(() => {
    if (!status.lastError) return;
    void navigator.clipboard.writeText(status.lastError).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [status.lastError]);

  const parsed = useMemo(
    () => (status.lastError ? parseError(status.lastError) : null),
    [status.lastError]
  );

  if (dismissed) return null;
  if (!status.pending && !status.lastTxHash && !status.lastError) return null;

  return (
    <div className="status-bar">
      {status.pending && <span className="pending">Transaction pending...</span>}
      {status.lastTxHash && (
        <span className="success">
          Tx: <code>{status.lastTxHash}</code>
          {status.proofSizeBytes != null && (
            <span className="proof-size">Proof: {formatProofSize(status.proofSizeBytes)}</span>
          )}
        </span>
      )}
      {parsed && (
        <div className="status-bar-error">
          <div className="status-bar-error-header">
            <span className="status-bar-error-summary">
              Error: {parsed.summary}
            </span>
            <span className="status-bar-error-actions">
              {parsed.structured && (
                <button
                  className="status-bar-detail-button"
                  onClick={() => setExpanded(!expanded)}
                >
                  {expanded ? "Less" : "Details"}
                </button>
              )}
              <button className="copy-error-button" onClick={copyError} title="Copy full error">
                {copied ? "Copied!" : "Copy"}
              </button>
            </span>
          </div>
          {expanded && parsed.txHash && (
            <div className="status-bar-error-detail">
              <span className="status-bar-error-label">Tx:</span>{" "}
              <code>{parsed.txHash}</code>
            </div>
          )}
          {expanded && parsed.revertReason && (
            <div className="status-bar-error-detail">
              <span className="status-bar-error-label">Reason:</span>{" "}
              <code className="status-bar-error-reason">
                {parsed.revertReason.length > MAX_SHORT_LENGTH
                  ? parsed.revertReason.slice(0, MAX_SHORT_LENGTH) + "\u2026"
                  : parsed.revertReason}
              </code>
            </div>
          )}
          {!parsed.structured && parsed.summary.length > MAX_SHORT_LENGTH && (
            <div className="status-bar-error-detail">
              <code className="status-bar-error-reason">
                {parsed.summary.slice(0, MAX_SHORT_LENGTH)}&hellip;
              </code>
            </div>
          )}
        </div>
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
