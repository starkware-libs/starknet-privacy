import type { PoolEntry } from "../hooks/usePoolSelector.ts";

type Props = {
  pools: PoolEntry[];
  activePool: PoolEntry;
  loading: boolean;
  deploying: boolean;
  deployError: string | null;
  onSelect: (address: string) => void;
  onDeploy: () => void;
};

function truncatePoolAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 8)}...${address.slice(-4)}`;
}

export function PoolSelector({
  pools,
  activePool,
  loading,
  deploying,
  deployError,
  onSelect,
  onDeploy,
}: Props) {
  return (
    <div className="pool-selector">
      <label>
        Pool:{" "}
        <select
          value={activePool.address}
          onChange={(event) => onSelect(event.target.value)}
        >
          {pools.map((pool) => (
            <option key={pool.address} value={pool.address}>
              {truncatePoolAddress(pool.address)}{pool.isDefault ? " (default)" : pool.isNewest ? " (newest)" : ""}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={loading || deploying} onClick={onDeploy}>
        {loading ? "Loading..." : deploying ? "Deploying..." : "Deploy New Pool"}
      </button>
      {deployError && <span className="error">{deployError}</span>}
    </div>
  );
}
