import { useState, useCallback, useEffect, useRef } from "react";
import { constants, hash, num, type RpcProvider } from "starknet";

export type PoolEntry = {
  address: string;
  blockNumber: number;
  isDefault: boolean;
};

export type SearchProgress = {
  scannedBlocks: number;
  totalBlocks: number;
  percent: number;
  /** Estimated seconds remaining, or null if not enough data */
  estimatedSecondsRemaining: number | null;
};

export type SearchState = {
  results: PoolEntry[];
  progress: SearchProgress;
  done: boolean;
};

const UDC_ADDRESS = constants.UDC.ADDRESS;
const CONTRACT_DEPLOYED_SELECTOR = hash.getSelectorFromName("ContractDeployed");
const CHUNK_SIZE = 1024;
const STORAGE_KEY = "poolSelection";

type StoredSelection = {
  defaultAddress: string;
  classHash: string;
  selectedAddress: string;
};

function loadStoredAddress(
  defaultAddress: string,
  classHash: string,
): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultAddress;
    const stored: StoredSelection = JSON.parse(raw);
    if (
      stored.defaultAddress === defaultAddress &&
      stored.classHash === classHash
    ) {
      return stored.selectedAddress;
    }
    return defaultAddress;
  } catch {
    return defaultAddress;
  }
}

function saveSelection(
  defaultAddress: string,
  classHash: string,
  selectedAddress: string,
): void {
  try {
    const value: StoredSelection = { defaultAddress, classHash, selectedAddress };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage unavailable
  }
}

export function usePoolSelector(
  provider: RpcProvider | undefined,
  defaultPoolAddress: string,
  poolClassHash: string,
) {
  const [activeAddress, setActiveAddress] = useState(() =>
    loadStoredAddress(defaultPoolAddress, poolClassHash),
  );
  const [search, setSearch] = useState<SearchState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const stored = loadStoredAddress(defaultPoolAddress, poolClassHash);
    setActiveAddress(stored);
    stopSearch();
  }, [defaultPoolAddress, poolClassHash]);

  const persist = useCallback(
    (address: string) => {
      saveSelection(defaultPoolAddress, poolClassHash, address);
    },
    [defaultPoolAddress, poolClassHash],
  );

  const selectPool = useCallback(
    (address: string) => {
      setActiveAddress(address);
      persist(address);
    },
    [persist],
  );

  const addPool = useCallback(
    (entry: PoolEntry) => {
      setActiveAddress(entry.address);
      persist(entry.address);
    },
    [persist],
  );

  const stopSearch = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const searchPools = useCallback(async () => {
    if (!provider) return;

    stopSearch();
    const controller = new AbortController();
    abortRef.current = controller;

    const normalizedClassHash = num.toHex(poolClassHash);
    const latestBlock = await provider.getBlockNumber();
    const seen = new Set<string>();
    const results: PoolEntry[] = [];
    const startTime = Date.now();
    let scannedBlocks = 0;

    setSearch({
      results: [],
      progress: { scannedBlocks: 0, totalBlocks: latestBlock, percent: 0, estimatedSecondsRemaining: null },
      done: false,
    });

    let continuationToken: string | undefined;

    try {
      do {
        if (controller.signal.aborted) return;

        const response = await provider.getEvents({
          address: UDC_ADDRESS,
          keys: [[CONTRACT_DEPLOYED_SELECTOR]],
          chunk_size: CHUNK_SIZE,
          ...(continuationToken ? { continuation_token: continuationToken } : {}),
        });

        for (const event of response.events) {
          const eventClassHash = event.data[3];
          if (eventClassHash && num.toHex(eventClassHash) === normalizedClassHash) {
            const address = event.data[0];
            const normalized = address.toLowerCase();
            if (!seen.has(normalized)) {
              seen.add(normalized);
              results.push({
                address,
                blockNumber: event.block_number ?? 0,
                isDefault: normalized === defaultPoolAddress.toLowerCase(),
              });
            }
          }
        }

        // Estimate progress from the last event's block number
        const lastEventBlock = response.events.length > 0
          ? (response.events[response.events.length - 1].block_number ?? scannedBlocks)
          : scannedBlocks;
        scannedBlocks = Math.max(scannedBlocks, lastEventBlock);

        const percent = latestBlock > 0
          ? Math.min(100, Math.round((scannedBlocks / latestBlock) * 100))
          : 0;
        const elapsedSeconds = (Date.now() - startTime) / 1000;
        const estimatedSecondsRemaining =
          percent > 0 && percent < 100
            ? Math.round((elapsedSeconds / percent) * (100 - percent))
            : null;

        if (!controller.signal.aborted) {
          setSearch({
            results: [...results].reverse(),
            progress: { scannedBlocks, totalBlocks: latestBlock, percent, estimatedSecondsRemaining },
            done: false,
          });
        }

        continuationToken = response.continuation_token;
      } while (continuationToken);

      if (!controller.signal.aborted) {
        setSearch({
          results: [...results].reverse(),
          progress: { scannedBlocks: latestBlock, totalBlocks: latestBlock, percent: 100, estimatedSecondsRemaining: null },
          done: true,
        });
      }
    } catch {
      if (!controller.signal.aborted) {
        setSearch((previous) =>
          previous ? { ...previous, done: true } : null,
        );
      }
    }
  }, [provider, poolClassHash, defaultPoolAddress, stopSearch]);

  const closeSearch = useCallback(() => {
    stopSearch();
    setSearch(null);
  }, [stopSearch]);

  return {
    activeAddress,
    search,
    selectPool,
    addPool,
    searchPools,
    stopSearch,
    closeSearch,
  };
}
