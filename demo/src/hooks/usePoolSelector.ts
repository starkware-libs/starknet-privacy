import { useState, useCallback, useEffect, useRef } from "react";
import { constants, hash, num, type RpcProvider } from "starknet";

export type PoolEntry = {
  address: string;
  isDefault: boolean;
  isNewest?: boolean;
};

const ACTIVE_POOL_STORAGE_KEY = "privacy-demo:active-pool";
const UDC_ADDRESS = constants.UDC.ADDRESS;
const CONTRACT_DEPLOYED_SELECTOR = hash.getSelectorFromName("ContractDeployed");
const CHUNK_SIZE = 1024;

function loadStoredAddress(): string | null {
  try {
    return localStorage.getItem(ACTIVE_POOL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistActiveAddress(address: string): void {
  localStorage.setItem(ACTIVE_POOL_STORAGE_KEY, address);
}

async function fetchPoolAddresses(provider: RpcProvider, poolClassHash: string): Promise<string[]> {
  const addresses: string[] = [];
  let continuationToken: string | undefined;
  const normalizedClassHash = num.toHex(poolClassHash);

  do {
    const response = await provider.getEvents({
      address: UDC_ADDRESS,
      keys: [[CONTRACT_DEPLOYED_SELECTOR]],
      chunk_size: CHUNK_SIZE,
      ...(continuationToken ? { continuation_token: continuationToken } : {}),
    });

    for (const event of response.events) {
      // ContractDeployed data: [address, deployer, unique, classHash, calldata_len, ...calldata, salt]
      const eventClassHash = event.data[3];
      if (eventClassHash && num.toHex(eventClassHash) === normalizedClassHash) {
        addresses.push(event.data[0]);
      }
    }

    continuationToken = response.continuation_token;
  } while (continuationToken);

  return addresses;
}

function buildPoolList(eventAddresses: string[], defaultPoolAddress: string): PoolEntry[] {
  const defaultEntry: PoolEntry = { address: defaultPoolAddress, isDefault: true };

  // Most recent first (events come chronologically, reverse for recency)
  const reversed = [...eventAddresses].reverse();
  const pools: PoolEntry[] = [];
  const seen = new Set<string>();

  for (const address of reversed) {
    const normalized = address.toLowerCase();
    if (normalized === defaultPoolAddress.toLowerCase()) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    pools.push({ address, isDefault: false, isNewest: pools.length === 0 });
  }

  // Default pool always at the bottom as fallback
  pools.push(defaultEntry);
  return pools;
}

export function usePoolSelector(
  provider: RpcProvider | undefined,
  defaultPoolAddress: string,
  poolClassHash: string
) {
  const defaultEntry: PoolEntry = { address: defaultPoolAddress, isDefault: true };
  const storedAddress = loadStoredAddress();

  // Active address resolves immediately: localStorage value or default — no waiting for fetch
  const [activeAddress, setActiveAddress] = useState<string>(storedAddress ?? defaultPoolAddress);
  const [pools, setPools] = useState<PoolEntry[]>(() => {
    if (storedAddress && storedAddress !== defaultPoolAddress) {
      return [{ address: storedAddress, isDefault: false }, defaultEntry];
    }
    return [defaultEntry];
  });
  const [loading, setLoading] = useState(false);

  // Track optimistic additions (from deploys) so they survive the background fetch
  const optimisticEntries = useRef<PoolEntry[]>([]);

  // Background fetch — populates the dropdown but does not change the active selection
  useEffect(() => {
    if (!provider) return;

    let cancelled = false;
    setLoading(true);

    fetchPoolAddresses(provider, poolClassHash)
      .then((addresses) => {
        if (cancelled) return;
        const fetched = buildPoolList(addresses, defaultPoolAddress);

        const fetchedNormalized = new Set(fetched.map((pool) => pool.address.toLowerCase()));
        const pendingOptimistic = optimisticEntries.current.filter(
          (entry) => !fetchedNormalized.has(entry.address.toLowerCase())
        );

        setPools([...pendingOptimistic, ...fetched]);
      })
      .catch(() => {
        if (cancelled) return;
        setPools([...optimisticEntries.current, defaultEntry]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [provider, poolClassHash, defaultPoolAddress]);

  const activePool = pools.find((pool) => pool.address === activeAddress) ?? {
    address: activeAddress,
    isDefault: activeAddress === defaultPoolAddress,
  };

  const selectPool = useCallback((address: string) => {
    setActiveAddress(address);
    persistActiveAddress(address);
  }, []);

  const addPool = useCallback((entry: PoolEntry) => {
    optimisticEntries.current = [entry, ...optimisticEntries.current];
    setPools((previous) => [entry, ...previous]);
    setActiveAddress(entry.address);
    persistActiveAddress(entry.address);
  }, []);

  return { pools, activePool, selectPool, addPool, loading };
}
