import type { PendingStored } from "../hooks/usePendingStored.ts";

type Props = {
  entries: PendingStored[];
  activeAddress: string | undefined;
  explorerUrl?: string;
  pending: boolean;
  onApply: (entry: PendingStored) => void;
  onDiscard: (actionsHash: string) => void;
};

function shortHash(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function formatRelative(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function PendingStoredPanel({
  entries,
  activeAddress,
  explorerUrl,
  pending,
  onApply,
  onDiscard,
}: Props) {
  const visible = activeAddress
    ? entries.filter((e) => BigInt(e.ownerAddress) === BigInt(activeAddress))
    : entries;
  if (visible.length === 0) return null;

  return (
    <div className="pending-stored-panel">
      <h3>Pending stored actions</h3>
      <p className="pending-stored-hint">
        Stored on chain by <code>store_actions</code>. Click <strong>Apply</strong> to run
        <code>apply_stored_actions</code> later.
      </p>
      <ul className="pending-stored-list">
        {visible.map((entry) => (
          <li key={entry.actionsHash} className="pending-stored-row">
            <span className="pending-stored-label">{entry.label}</span>
            <span className="pending-stored-hash" title={entry.actionsHash}>
              hash {shortHash(entry.actionsHash)}
            </span>
            <span className="pending-stored-time">{formatRelative(entry.createdAt)}</span>
            {explorerUrl && (
              <a
                className="pending-stored-link"
                href={`${explorerUrl.replace(/\/$/, "")}/tx/${entry.storeTxHash}`}
                target="_blank"
                rel="noreferrer"
              >
                store tx ↗
              </a>
            )}
            <button
              type="button"
              className="pool-action-button"
              disabled={pending}
              onClick={() => onApply(entry)}
            >
              Apply
            </button>
            <button
              type="button"
              className="pool-action-button secondary"
              disabled={pending}
              onClick={() => onDiscard(entry.actionsHash)}
              title="Remove this entry locally without applying. The on-chain entry remains until you call apply_stored_actions."
            >
              Discard
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
