import { useCallback, useEffect, useRef, useState } from "react";

// Minimal EIP-1193 surface we rely on. Cast through `unknown` rather than
// reaching for the full ethers/viem types — we want zero new dependencies.
interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  isMetaMask?: boolean;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export type EthWalletStatus =
  | { kind: "no-wallet" }
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; address: string; chainIdHex: string }
  | { kind: "error"; message: string };

interface UseEthWalletResult {
  status: EthWalletStatus;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const STORAGE_KEY = "shielded-swap.eth-wallet.wants-connect";

export function useEthWallet(): UseEthWalletResult {
  const [status, setStatus] = useState<EthWalletStatus>(() =>
    typeof window !== "undefined" && window.ethereum
      ? { kind: "idle" }
      : { kind: "no-wallet" },
  );
  const providerRef = useRef<Eip1193Provider | null>(
    typeof window !== "undefined" ? (window.ethereum ?? null) : null,
  );

  const connect = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) {
      setStatus({ kind: "no-wallet" });
      return;
    }
    setStatus({ kind: "connecting" });
    try {
      const accountsRaw = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      const chainIdRaw = (await provider.request({
        method: "eth_chainId",
      })) as string;
      const address = accountsRaw[0];
      if (!address) {
        setStatus({ kind: "error", message: "No accounts available" });
        return;
      }
      localStorage.setItem(STORAGE_KEY, "1");
      setStatus({ kind: "connected", address, chainIdHex: chainIdRaw });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 4001 is the EIP-1193 user-rejected code; treat as soft cancel.
      if (/4001|user reject|denied/i.test(message)) {
        setStatus({ kind: "idle" });
        return;
      }
      setStatus({ kind: "error", message });
    }
  }, []);

  const disconnect = useCallback(() => {
    // EIP-1193 has no on-chain "disconnect"; we just forget the state. The
    // user has to revoke at the wallet level to truly sever the dapp.
    localStorage.removeItem(STORAGE_KEY);
    setStatus({ kind: "idle" });
  }, []);

  // Listen for account / chain changes from the wallet itself.
  useEffect(() => {
    const provider = providerRef.current;
    if (!provider?.on || !provider.removeListener) return;
    const onAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      const next = accounts?.[0];
      setStatus((prev) => {
        if (!next) {
          localStorage.removeItem(STORAGE_KEY);
          return { kind: "idle" };
        }
        if (prev.kind === "connected") {
          return { ...prev, address: next };
        }
        return prev;
      });
    };
    const onChainChanged = (...args: unknown[]) => {
      const chainIdHex = args[0] as string;
      setStatus((prev) =>
        prev.kind === "connected" ? { ...prev, chainIdHex } : prev,
      );
    };
    provider.on("accountsChanged", onAccountsChanged);
    provider.on("chainChanged", onChainChanged);
    return () => {
      provider.removeListener?.("accountsChanged", onAccountsChanged);
      provider.removeListener?.("chainChanged", onChainChanged);
    };
  }, []);

  // Silent reconnect on reload if the user previously connected.
  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY) !== "1") return;
    const provider = providerRef.current;
    if (!provider) return;
    (async () => {
      try {
        const accounts = (await provider.request({
          method: "eth_accounts",
        })) as string[];
        const address = accounts[0];
        if (!address) {
          localStorage.removeItem(STORAGE_KEY);
          return;
        }
        const chainIdHex = (await provider.request({
          method: "eth_chainId",
        })) as string;
        setStatus({ kind: "connected", address, chainIdHex });
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    })();
  }, []);

  return { status, connect, disconnect };
}
