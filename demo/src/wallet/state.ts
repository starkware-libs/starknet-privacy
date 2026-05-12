// Wallet-local toggles. Stored under different keys than the original demo so
// the two UIs can coexist without stomping on each other's preferences.

import { useCallback, useState } from "react";

export function useStoredBool(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    const raw = localStorage.getItem(`wallet:${key}`);
    if (raw === null) return fallback;
    return raw === "true";
  });
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      localStorage.setItem(`wallet:${key}`, String(next));
    },
    [key]
  );
  return [value, update];
}

export function useStoredString(
  key: string,
  fallback: string | undefined
): [string | undefined, (value: string | undefined) => void] {
  const [value, setValue] = useState<string | undefined>(() => {
    const raw = localStorage.getItem(`wallet:${key}`);
    return raw ?? fallback;
  });
  const update = useCallback(
    (next: string | undefined) => {
      setValue(next);
      if (next === undefined) {
        localStorage.removeItem(`wallet:${key}`);
      } else {
        localStorage.setItem(`wallet:${key}`, next);
      }
    },
    [key]
  );
  return [value, update];
}
