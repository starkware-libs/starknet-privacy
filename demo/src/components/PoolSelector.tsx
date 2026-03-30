import { useState } from "react";
import type { SearchState } from "../hooks/usePoolSelector.ts";

type Props = {
  activeAddress: string;
  search: SearchState | null;
  deploying: boolean;
  deployError: string | null;
  classHash: string;
  onSelect: (address: string) => void;
  onSearch: () => void;
  onStopSearch: () => void;
  onCloseSearch: () => void;
  onDeploy: () => void;
  onClassHashChange: (hash: string) => void;
};

function truncateHash(hex: string): string {
  if (hex.length <= 14) return hex;
  return `${hex.slice(0, 8)}...${hex.slice(-4)}`;
}

export function PoolSelector({
  activeAddress,
  search,
  deploying,
  deployError,
  classHash,
  onSelect,
  onSearch,
  onStopSearch,
  onCloseSearch,
  onDeploy,
  onClassHashChange,
}: Props) {
  const [editingClassHash, setEditingClassHash] = useState(false);
  const [classHashDraft, setClassHashDraft] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);
  const [addressDraft, setAddressDraft] = useState("");

  const applyAddress = () => {
    if (addressDraft.trim()) {
      onSelect(addressDraft.trim());
      setEditingAddress(false);
    }
  };

  const handleApplyResult = (address: string) => {
    onStopSearch();
    onSelect(address);
    onCloseSearch();
  };

  return (
    <div className="pool-selector-grid">
      <span className="pool-selector-label">Class hash:</span>
      <div className="pool-selector-value">
        {editingClassHash ? (
          <>
            <input
              value={classHashDraft}
              onChange={(event) => setClassHashDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onClassHashChange(classHashDraft);
                  setEditingClassHash(false);
                }
                if (event.key === "Escape") setEditingClassHash(false);
              }}
              autoFocus
            />
            <button
              onClick={() => {
                onClassHashChange(classHashDraft);
                setEditingClassHash(false);
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
                setClassHashDraft(classHash);
                setEditingClassHash(true);
              }}
            >
              Change
            </button>
            <button
              type="button"
              className="pool-action-button"
              onClick={onSearch}
              disabled={search !== null && !search.done}
            >
              Scan deployments
            </button>
          </>
        )}
      </div>

      <span className="pool-selector-label">Address:</span>
      <div className="pool-selector-value">
        {editingAddress ? (
          <>
            <input
              value={addressDraft}
              onChange={(event) => setAddressDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyAddress();
                if (event.key === "Escape") setEditingAddress(false);
              }}
              placeholder="0x..."
              autoFocus
            />
            <button onClick={applyAddress}>Apply</button>
            <button onClick={() => setEditingAddress(false)}>Cancel</button>
          </>
        ) : (
          <>
            <code>{truncateHash(activeAddress)}</code>
            <button
              onClick={() => {
                setAddressDraft(activeAddress);
                setEditingAddress(true);
              }}
            >
              Change
            </button>
            <button type="button" className="pool-action-button" disabled={deploying} onClick={onDeploy}>
              {deploying ? "Deploying..." : "Re-deploy"}
            </button>
            {deployError && <span className="error">{deployError}</span>}
          </>
        )}
      </div>

      {search && (
        <div className="search-popup-overlay" onClick={onCloseSearch}>
          <div className="search-popup" onClick={(event) => event.stopPropagation()}>
            <div className="search-popup-header">
              <span>Pool deployments</span>
              <div className="search-popup-header-actions">
                {!search.done && (
                  <button className="pool-action-button" onClick={onStopSearch}>Stop</button>
                )}
                <button className="pool-action-button" onClick={onCloseSearch}>Close</button>
              </div>
            </div>
            <div className="search-progress">
              <div className="search-progress-bar">
                <div
                  className="search-progress-fill"
                  style={{ width: `${search.progress.percent}%` }}
                />
              </div>
              <span className="search-progress-text">
                {search.done
                  ? `Done — ${search.results.length} pool${search.results.length !== 1 ? "s" : ""} found`
                  : `${search.progress.percent}% scanned`
                    + (search.progress.estimatedSecondsRemaining !== null
                      ? ` — ~${search.progress.estimatedSecondsRemaining}s remaining`
                      : "")}
              </span>
            </div>
            {search.results.length > 0 ? (
              <table className="search-results-table">
                <thead>
                  <tr>
                    <th>Address</th>
                    <th>Block</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {search.results.map((pool) => (
                    <tr
                      key={pool.address}
                      className={pool.address === activeAddress ? "search-result-active" : ""}
                    >
                      <td><code>{truncateHash(pool.address)}</code></td>
                      <td>{pool.blockNumber.toLocaleString()}</td>
                      <td className="search-result-apply">
                        <button
                          className="pool-action-button"
                          onClick={() => handleApplyResult(pool.address)}
                        >
                          Apply
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : search.done ? (
              <div className="empty">No pools found for this class hash</div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
