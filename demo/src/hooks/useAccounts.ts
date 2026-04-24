import { useState, useCallback } from "react";
import type { AccountConfig } from "../config.ts";

const ACCOUNTS_KEY = "accounts";
const ACTIVE_INDEX_KEY = "activeAccountIndex";

function loadStoredAccounts(): AccountConfig[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as AccountConfig[];
  } catch {
    return [];
  }
}

function firstNonAdminIndex(accounts: AccountConfig[]): number {
  const index = accounts.findIndex((a) => !a.admin);
  return index >= 0 ? index : 0;
}

function loadStoredIndex(accounts: AccountConfig[]): number {
  const fallback = firstNonAdminIndex(accounts);
  try {
    const saved = localStorage.getItem(ACTIVE_INDEX_KEY);
    if (saved === null) return fallback;
    const parsed = Number(saved);
    return parsed >= 0 && parsed < accounts.length ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// Accepts entries with any of:
//   - privateKey + viewingKey: full account, viewing key used as-is
//   - privateKey only: full account, viewing key derived (see `deriveViewingKey`)
//   - viewingKey only: view-only (action buttons gated via `isSendCapable`)
// `name` and `address` are always required. At least one of privateKey /
// viewingKey must be present.
function parseAccounts(raw: string): AccountConfig[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
  for (const entry of parsed) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.name !== "string" ||
      typeof entry.address !== "string" ||
      (entry.privateKey !== undefined && typeof entry.privateKey !== "string") ||
      (entry.viewingKey !== undefined && typeof entry.viewingKey !== "string")
    ) {
      throw new Error("Each account must have name and address");
    }
    if (!entry.privateKey && !entry.viewingKey) {
      throw new Error(
        `Account "${entry.name}" must supply privateKey (to derive the viewing key) or viewingKey (for view-only)`
      );
    }
  }
  return parsed as AccountConfig[];
}

function saveAccounts(accounts: AccountConfig[]): void {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  localStorage.setItem(ACTIVE_INDEX_KEY, String(firstNonAdminIndex(accounts)));
}

export type UseAccountsResult = {
  accounts: AccountConfig[];
  activeIndex: number;
  activeAccount: AccountConfig | undefined;
  setActiveIndex: (index: number) => void;
  /** Parse JSON, validate, set accounts. Returns error message or null. */
  importAccounts: (raw: string) => string | null;
};

// `persist=false` keeps accounts in memory only — nothing is written to
// localStorage and no localStorage is read on mount. Used on mainnet so a
// pasted signing key never survives a page reload.
export function useAccounts(persist: boolean = true): UseAccountsResult {
  const [accounts, setAccounts] = useState<AccountConfig[]>(() =>
    persist ? loadStoredAccounts() : []
  );
  const [activeIndex, setActiveIndexState] = useState(() =>
    persist ? loadStoredIndex(accounts) : 0
  );

  const setActiveIndex = useCallback(
    (index: number) => {
      setActiveIndexState(index);
      if (!persist) return;
      try {
        localStorage.setItem(ACTIVE_INDEX_KEY, String(index));
      } catch {
        // localStorage unavailable — ignore
      }
    },
    [persist]
  );

  const importAccounts = useCallback(
    (raw: string): string | null => {
      try {
        const parsed = parseAccounts(raw);
        if (parsed.length === 0) return "No accounts in the list";
        if (persist) saveAccounts(parsed);
        setAccounts(parsed);
        setActiveIndexState(firstNonAdminIndex(parsed));
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : "Invalid JSON";
      }
    },
    [persist]
  );

  return {
    accounts,
    activeIndex,
    activeAccount: accounts[activeIndex],
    setActiveIndex,
    importAccounts,
  };
}
