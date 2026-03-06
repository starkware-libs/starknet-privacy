import { useState, useCallback } from "react";
import type { AccountConfig } from "../config.ts";

const STORAGE_KEY = "activeAccountIndex";

function loadSavedIndex(maxIndex: number): number {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === null) return 0;
    const parsed = Number(saved);
    return parsed >= 0 && parsed <= maxIndex ? parsed : 0;
  } catch {
    return 0;
  }
}

export type UseAccountsResult = {
  accounts: AccountConfig[];
  activeIndex: number;
  activeAccount: AccountConfig | undefined;
  setActiveIndex: (index: number) => void;
};

export function useAccounts(initialAccounts: AccountConfig[]): UseAccountsResult {
  const [activeIndex, setActiveIndexState] = useState(() =>
    loadSavedIndex(initialAccounts.length - 1)
  );

  const setActiveIndex = useCallback((index: number) => {
    setActiveIndexState(index);
    try {
      localStorage.setItem(STORAGE_KEY, String(index));
    } catch {
      // localStorage unavailable — ignore
    }
  }, []);

  return {
    accounts: initialAccounts,
    activeIndex,
    activeAccount: initialAccounts[activeIndex],
    setActiveIndex,
  };
}
