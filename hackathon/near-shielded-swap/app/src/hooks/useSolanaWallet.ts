import { useCallback, useEffect, useRef, useState } from "react";

export interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toString: () => string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{
    publicKey: { toString: () => string };
  }>;
  disconnect: () => Promise<void>;
  /** Available once the user has approved a connect; needed by useSolanaSend. */
  signAndSendTransaction?: (
    transaction: unknown,
  ) => Promise<{ signature: string }>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    solana?: PhantomProvider;
    phantom?: { solana?: PhantomProvider };
  }
}

function detectPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  // Phantom historically used `window.solana`; the newer convention is
  // `window.phantom.solana`. Prefer the namespaced one when both exist.
  return window.phantom?.solana ?? window.solana ?? null;
}

export type SolanaWalletStatus =
  | { kind: "no-wallet" }
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; address: string; walletName: string }
  | { kind: "error"; message: string };

interface UseSolanaWalletResult {
  status: SolanaWalletStatus;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const STORAGE_KEY = "shielded-swap.solana-wallet.wants-connect";

export function useSolanaWallet(): UseSolanaWalletResult {
  const providerRef = useRef<PhantomProvider | null>(detectPhantom());
  const [status, setStatus] = useState<SolanaWalletStatus>(() =>
    providerRef.current ? { kind: "idle" } : { kind: "no-wallet" },
  );

  const connect = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) {
      setStatus({ kind: "no-wallet" });
      return;
    }
    setStatus({ kind: "connecting" });
    try {
      const resp = await provider.connect();
      const address = resp.publicKey.toString();
      localStorage.setItem(STORAGE_KEY, "1");
      setStatus({
        kind: "connected",
        address,
        walletName: provider.isPhantom ? "Phantom" : "Solana wallet",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Phantom uses error code 4001 for user-reject too; soft cancel.
      if (/4001|user reject|denied|user reject the request/i.test(message)) {
        setStatus({ kind: "idle" });
        return;
      }
      setStatus({ kind: "error", message });
    }
  }, []);

  const disconnect = useCallback(async () => {
    const provider = providerRef.current;
    try {
      await provider?.disconnect();
    } finally {
      localStorage.removeItem(STORAGE_KEY);
      setStatus({ kind: "idle" });
    }
  }, []);

  // Listen for in-wallet disconnect / account change.
  useEffect(() => {
    const provider = providerRef.current;
    if (!provider?.on || !provider.removeListener) return;
    const onDisconnect = () => {
      localStorage.removeItem(STORAGE_KEY);
      setStatus({ kind: "idle" });
    };
    const onAccountChanged = (...args: unknown[]) => {
      const pk = args[0] as { toString: () => string } | null;
      setStatus((prev) => {
        if (!pk) {
          localStorage.removeItem(STORAGE_KEY);
          return { kind: "idle" };
        }
        const address = pk.toString();
        if (prev.kind === "connected") {
          return { ...prev, address };
        }
        return prev;
      });
    };
    provider.on("disconnect", onDisconnect);
    provider.on("accountChanged", onAccountChanged);
    return () => {
      provider.removeListener?.("disconnect", onDisconnect);
      provider.removeListener?.("accountChanged", onAccountChanged);
    };
  }, []);

  // Silent reconnect on reload if the user previously connected.
  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY) !== "1") return;
    const provider = providerRef.current;
    if (!provider) return;
    (async () => {
      try {
        const resp = await provider.connect({ onlyIfTrusted: true });
        const address = resp.publicKey.toString();
        setStatus({
          kind: "connected",
          address,
          walletName: provider.isPhantom ? "Phantom" : "Solana wallet",
        });
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    })();
  }, []);

  return { status, connect, disconnect };
}
