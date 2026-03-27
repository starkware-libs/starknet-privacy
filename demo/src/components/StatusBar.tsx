import type { TransactionStatus } from "../hooks/useTransactions.ts";

function formatProofSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

type Props = {
  status: TransactionStatus;
};

export function StatusBar({ status }: Props) {
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
      {status.lastError && (
        <span className="error">Error: {status.lastError}</span>
      )}
    </div>
  );
}
