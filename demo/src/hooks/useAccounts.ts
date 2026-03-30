import { useState, useCallback } from "react";
import type { AccountConfig } from "../config.ts";

const ACCOUNTS_KEY = "accounts";
const ACTIVE_INDEX_KEY = "activeAccountIndex";
const QUERY_PARAM = "accounts";

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

/** Parse and validate the JSON accounts string (same format as VITE_ACCOUNTS). */
function parseAccounts(raw: string): AccountConfig[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
  for (const entry of parsed) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.name !== "string" ||
      typeof entry.address !== "string" ||
      typeof entry.privateKey !== "string" ||
      typeof entry.viewingKey !== "string"
    ) {
      throw new Error(
        "Each account must have name, address, privateKey, viewingKey",
      );
    }
  }
  return parsed as AccountConfig[];
}

function saveAccounts(accounts: AccountConfig[]): void {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  localStorage.setItem(
    ACTIVE_INDEX_KEY,
    String(firstNonAdminIndex(accounts)),
  );
}

/** Try to load accounts from the `?accounts=<base64>` query param. */
function loadFromQueryParam(): AccountConfig[] | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const encoded = params.get(QUERY_PARAM);
    if (!encoded) return null;
    const json = atob(encoded);
    const accounts = parseAccounts(json);
    if (accounts.length === 0) return null;
    // Persist and strip the query param from the URL
    saveAccounts(accounts);
    params.delete(QUERY_PARAM);
    const cleanUrl =
      window.location.pathname +
      (params.size > 0 ? `?${params.toString()}` : "") +
      window.location.hash;
    window.history.replaceState(null, "", cleanUrl);
    return accounts;
  } catch {
    return null;
  }
}

/** Build a shareable URL with accounts encoded as a base64 query param. */
export function buildShareUrl(accounts: AccountConfig[]): string {
  const encoded = btoa(JSON.stringify(accounts));
  const url = new URL(window.location.href);
  url.searchParams.set(QUERY_PARAM, encoded);
  return url.toString();
}

export type UseAccountsResult = {
  accounts: AccountConfig[];
  activeIndex: number;
  activeAccount: AccountConfig | undefined;
  setActiveIndex: (index: number) => void;
  /** Parse JSON, validate, persist to localStorage. Returns error message or null. */
  importAccounts: (raw: string) => string | null;
};

export function useAccounts(): UseAccountsResult {
  const [accounts, setAccounts] = useState(
    () => loadFromQueryParam() ?? loadStoredAccounts(),
  );
  const [activeIndex, setActiveIndexState] = useState(() =>
    loadStoredIndex(accounts),
  );

  const setActiveIndex = useCallback((index: number) => {
    setActiveIndexState(index);
    try {
      localStorage.setItem(ACTIVE_INDEX_KEY, String(index));
    } catch {
      // localStorage unavailable — ignore
    }
  }, []);

  const importAccounts = useCallback((raw: string): string | null => {
    try {
      const parsed = parseAccounts(raw);
      if (parsed.length === 0) return "No accounts in the list";
      saveAccounts(parsed);
      setAccounts(parsed);
      setActiveIndexState(firstNonAdminIndex(parsed));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid JSON";
    }
  }, []);

  return {
    accounts,
    activeIndex,
    activeAccount: accounts[activeIndex],
    setActiveIndex,
    importAccounts,
  };
}
