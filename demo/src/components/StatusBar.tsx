import type { TransactionStatus } from "../hooks/useTransactions.ts";

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
        </span>
      )}
      {status.lastError && <span className="error">Error: {status.lastError}</span>}
    </div>
  );
}
