import { useState } from "react";
import type { PoolEntry } from "../hooks/usePoolSelector.ts";

type Props = {
  pools: PoolEntry[];
  activePool: PoolEntry;
  loading: boolean;
  deploying: boolean;
  deployError: string | null;
  classHash: string;
  onSelect: (address: string) => void;
  onDeploy: () => void;
  onClassHashChange: (hash: string) => void;
};

function truncateHash(hex: string): string {
  if (hex.length <= 14) return hex;
  return `${hex.slice(0, 8)}...${hex.slice(-4)}`;
}

export function PoolSelector({
  pools,
  activePool,
  loading,
  deploying,
  deployError,
  classHash,
  onSelect,
  onDeploy,
  onClassHashChange,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  return (
    <div className="pool-selector-grid">
      <span className="pool-selector-label">Class hash:</span>
      <div className="pool-selector-value">
        {editing ? (
          <>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onClassHashChange(draft);
                  setEditing(false);
                }
                if (event.key === "Escape") setEditing(false);
              }}
              autoFocus
            />
            <button
              onClick={() => {
                onClassHashChange(draft);
                setEditing(false);
              }}
            >
              Apply
            </button>
          </>
        ) : (
          <>
            <code>{truncateHash(classHash)}</code>
            <button
              onClick={() => {
                setDraft(classHash);
                setEditing(true);
              }}
            >
              Change
            </button>
          </>
        )}
      </div>

      <span className="pool-selector-label">Address:{loading && <span className="chip">scanning...</span>}</span>
      <div className="pool-selector-value">
        <select
          value={activePool.address}
          onChange={(event) => onSelect(event.target.value)}
        >
          {pools.map((pool) => (
            <option key={pool.address} value={pool.address}>
              {truncateHash(pool.address)}{pool.isDefault ? " (default)" : pool.isNewest ? " (newest)" : ""}
            </option>
          ))}
        </select>
        <button type="button" disabled={deploying} onClick={onDeploy}>
          {deploying ? "Deploying..." : "Deploy New Pool"}
        </button>
        <button
          type="button"
          className="copy-button"
          onClick={() => {
            navigator.clipboard.writeText(activePool.address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        {deployError && <span className="error">{deployError}</span>}
      </div>
    </div>
  );
}
