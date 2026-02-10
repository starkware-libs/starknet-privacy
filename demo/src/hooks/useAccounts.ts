import { useState, useCallback } from "react";
import type { AccountConfig } from "../config.ts";

export type UseAccountsResult = {
  accounts: AccountConfig[];
  activeIndex: number;
  activeAccount: AccountConfig | undefined;
  setActiveIndex: (index: number) => void;
  addAccount: (account: AccountConfig) => void;
};

export function useAccounts(initialAccounts: AccountConfig[]): UseAccountsResult {
  const [accounts, setAccounts] = useState<AccountConfig[]>(initialAccounts);
  const [activeIndex, setActiveIndex] = useState(0);

  const addAccount = useCallback((account: AccountConfig) => {
    setAccounts((prev) => [...prev, account]);
  }, []);

  return {
    accounts,
    activeIndex,
    activeAccount: accounts[activeIndex],
    setActiveIndex,
    addAccount,
  };
}
