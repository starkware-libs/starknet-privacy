import { useCallback, useState } from "react";

export type PendingStored = {
  actionsHash: string;
  label: string;
  createdAt: number;
  storeTxHash: string;
  ownerAddress: string;
};

const PENDING_STORED_KEY = "pendingStoredActions";

function readPendingStored(): PendingStored[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(PENDING_STORED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingStored[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePendingStored(entries: PendingStored[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(PENDING_STORED_KEY, JSON.stringify(entries));
}

export function usePendingStored() {
  const [entries, setEntries] = useState<PendingStored[]>(() => readPendingStored());
  const add = useCallback((entry: PendingStored) => {
    setEntries((previous) => {
      const next = [...previous.filter((e) => e.actionsHash !== entry.actionsHash), entry];
      writePendingStored(next);
      return next;
    });
  }, []);
  const remove = useCallback((actionsHash: string) => {
    setEntries((previous) => {
      const next = previous.filter((e) => e.actionsHash !== actionsHash);
      writePendingStored(next);
      return next;
    });
  }, []);
  return { entries, add, remove };
}
