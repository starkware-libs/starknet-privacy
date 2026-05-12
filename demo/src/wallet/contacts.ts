import { useCallback, useEffect, useState } from "react";

export type Contact = {
  name: string;
  address: string;
};

const KEY = "wallet:contacts";

function load(): Contact[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Contact =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Contact).name === "string" &&
        typeof (entry as Contact).address === "string"
    );
  } catch {
    return [];
  }
}

function save(contacts: Contact[]): void {
  localStorage.setItem(KEY, JSON.stringify(contacts));
}

function normalizeAddress(address: string): string {
  // Lowercase + 0x-prefix the hex so de-dupe matches across casing/no-prefix.
  // Reject anything that isn't valid hex once stripped — saves callers from
  // accepting junk that won't BigInt-parse downstream.
  const trimmed = address.trim().toLowerCase();
  const stripped = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (stripped.length === 0 || !/^[0-9a-f]+$/.test(stripped)) {
    throw new Error("Address must be hex (0x… or raw hex digits)");
  }
  return `0x${stripped}`;
}

export type UseContactsResult = {
  contacts: Contact[];
  add: (name: string, address: string) => string | null;
  remove: (address: string) => void;
  update: (originalAddress: string, name: string, address: string) => string | null;
  /** Lookup by name (case-insensitive). Returns the canonical address. */
  resolveByName: (input: string) => Contact | undefined;
  /** Lookup by address (case-insensitive, with/without 0x). */
  findByAddress: (address: string) => Contact | undefined;
};

export function useContacts(): UseContactsResult {
  const [contacts, setContacts] = useState<Contact[]>(load);

  // Cross-tab sync: if Settings adds a contact and the user opens the Send
  // modal in another tab, the chips reflect the new contact on next render
  // without a manual reload.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === KEY) setContacts(load());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const add = useCallback((name: string, address: string): string | null => {
    const cleanName = name.trim();
    if (!cleanName) return "Name is required";
    let canonical: string;
    try {
      canonical = normalizeAddress(address);
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid address";
    }
    let error: string | null = null;
    setContacts((previous) => {
      if (previous.some((entry) => entry.name.toLowerCase() === cleanName.toLowerCase())) {
        error = `Contact "${cleanName}" already exists`;
        return previous;
      }
      if (previous.some((entry) => entry.address.toLowerCase() === canonical)) {
        error = "Address already in contacts";
        return previous;
      }
      const next = [...previous, { name: cleanName, address: canonical }];
      save(next);
      return next;
    });
    return error;
  }, []);

  const remove = useCallback((address: string): void => {
    const target = address.toLowerCase();
    setContacts((previous) => {
      const next = previous.filter((entry) => entry.address.toLowerCase() !== target);
      save(next);
      return next;
    });
  }, []);

  const update = useCallback(
    (originalAddress: string, name: string, address: string): string | null => {
      const cleanName = name.trim();
      if (!cleanName) return "Name is required";
      let canonical: string;
      try {
        canonical = normalizeAddress(address);
      } catch (error) {
        return error instanceof Error ? error.message : "Invalid address";
      }
      const original = originalAddress.toLowerCase();
      let error: string | null = null;
      setContacts((previous) => {
        if (
          previous.some(
            (entry) =>
              entry.name.toLowerCase() === cleanName.toLowerCase() &&
              entry.address.toLowerCase() !== original
          )
        ) {
          error = `Contact "${cleanName}" already exists`;
          return previous;
        }
        const next = previous.map((entry) =>
          entry.address.toLowerCase() === original
            ? { name: cleanName, address: canonical }
            : entry
        );
        save(next);
        return next;
      });
      return error;
    },
    []
  );

  const resolveByName = useCallback(
    (input: string): Contact | undefined => {
      const target = input.trim().toLowerCase();
      if (!target) return undefined;
      return contacts.find((entry) => entry.name.toLowerCase() === target);
    },
    [contacts]
  );

  const findByAddress = useCallback(
    (address: string): Contact | undefined => {
      try {
        const canonical = normalizeAddress(address);
        return contacts.find((entry) => entry.address.toLowerCase() === canonical);
      } catch {
        return undefined;
      }
    },
    [contacts]
  );

  return { contacts, add, remove, update, resolveByName, findByAddress };
}
