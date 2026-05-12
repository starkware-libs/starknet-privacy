import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { connect, disconnect } from "starknetkit";
import type { StarknetWindowObject } from "starknetkit";
import type { AccountInterface } from "starknet";
import { CHAIN } from "../lib/chain";
import { deriveIdentity, type ShieldedIdentity } from "../lib/identity";

export type WalletStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; address: string; chainId: string; walletId: string; walletName: string }
  | { kind: "error"; message: string };

export type IdentityStatus =
  | { kind: "none" }
  | { kind: "deriving" }
  | { kind: "ready"; identity: ShieldedIdentity }
  | { kind: "rejected" }
  | { kind: "error"; message: string };

interface WalletContextValue {
  status: WalletStatus;
  identity: IdentityStatus;
  wallet: StarknetWindowObject | null;
  connectWallet: () => Promise<void>;
  cancelConnect: () => void;
  disconnectWallet: () => Promise<void>;
  setupIdentity: () => Promise<void>;
}

const Ctx = createContext<WalletContextValue | null>(null);

const PERSIST_KEY = "shielded-swap.wallet.wants-connect";

// We wrap the starknetkit interactions in a small state machine so the UI can
// distinguish: never tried / dialog open / connected / user-rejected.
export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>({ kind: "idle" });
  const [identity, setIdentity] = useState<IdentityStatus>({ kind: "none" });
  const walletRef = useRef<StarknetWindowObject | null>(null);
  const accountRef = useRef<AccountInterface | null>(null);

  const setupIdentity = useCallback(async () => {
    const acct = accountRef.current;
    if (!acct) {
      setIdentity({ kind: "error", message: "Wallet not connected" });
      return;
    }
    setIdentity({ kind: "deriving" });
    try {
      const derived = await deriveIdentity(acct);
      setIdentity({ kind: "ready", identity: derived });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Wallets surface user-rejection in a variety of strings; the user-facing
      // distinction matters because rejected ≠ broken — just offer the CTA again.
      const rejected = /reject|denied|cancel|user/i.test(message);
      setIdentity(rejected ? { kind: "rejected" } : { kind: "error", message });
    }
  }, []);

  const reflectConnection = useCallback(
    (
      wallet: StarknetWindowObject | null | undefined,
      data: { account?: string | AccountInterface; chainId?: bigint | string } | null | undefined,
    ) => {
      // starknetkit returns `data.account` as either an address string or a
      // starknet.js AccountInterface depending on the connector. Normalize.
      const accountField = data?.account;
      const account =
        accountField && typeof accountField === "object" ? accountField : null;
      const address =
        typeof accountField === "string"
          ? accountField
          : (account?.address ?? "");
      if (!wallet || !address) {
        walletRef.current = null;
        accountRef.current = null;
        setStatus({ kind: "idle" });
        setIdentity({ kind: "none" });
        return;
      }
      const raw = data?.chainId;
      const chainId =
        typeof raw === "bigint" ? `0x${raw.toString(16)}` : (raw ?? CHAIN.chainId);
      walletRef.current = wallet;
      // `wallet.account` is the modern hook; older wallets expose only methods.
      const w = wallet as unknown as { account?: AccountInterface };
      accountRef.current = account ?? w.account ?? null;
      setStatus({
        kind: "connected",
        address,
        chainId,
        walletId: wallet.id ?? "unknown",
        walletName: wallet.name ?? "Wallet",
      });
    },
    [],
  );

  // `cancelTokenRef` makes the connecting state user-cancellable. Clicking the
  // "Connecting…" pill while a starknetkit modal is open flips the token; the
  // in-flight promise (which might still resolve later if the user opens the
  // modal from another tab, etc.) becomes a no-op by checking the token after
  // the await.
  const cancelTokenRef = useRef(0);

  const cancelConnect = useCallback(() => {
    cancelTokenRef.current += 1;
    setStatus({ kind: "idle" });
  }, []);

  const connectWallet = useCallback(async () => {
    const ticket = ++cancelTokenRef.current;
    setStatus({ kind: "connecting" });
    try {
      const result = await connect({
        modalMode: "alwaysAsk",
        dappName: "Shielded Swap",
        modalTheme: "dark",
      });
      if (cancelTokenRef.current !== ticket) return; // cancelled by user
      if (!result || !result.wallet) {
        // User dismissed the modal — treat as a soft cancel, not an error.
        setStatus({ kind: "idle" });
        return;
      }
      localStorage.setItem(PERSIST_KEY, "1");
      reflectConnection(result.wallet, result.connectorData);
    } catch (err) {
      if (cancelTokenRef.current !== ticket) return;
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", message });
    }
  }, [reflectConnection]);

  const disconnectWallet = useCallback(async () => {
    try {
      await disconnect({ clearLastWallet: true });
    } finally {
      localStorage.removeItem(PERSIST_KEY);
      walletRef.current = null;
      accountRef.current = null;
      setStatus({ kind: "idle" });
      setIdentity({ kind: "none" });
    }
  }, []);

  // Silent reconnect on page load if the user previously connected.
  useEffect(() => {
    if (localStorage.getItem(PERSIST_KEY) !== "1") return;
    let cancelled = false;
    (async () => {
      try {
        const result = await connect({
          modalMode: "neverAsk",
          dappName: "Shielded Swap",
        });
        if (cancelled) return;
        if (result?.wallet) {
          reflectConnection(result.wallet, result.connectorData);
        } else {
          localStorage.removeItem(PERSIST_KEY);
        }
      } catch {
        localStorage.removeItem(PERSIST_KEY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reflectConnection]);

  const value = useMemo<WalletContextValue>(
    () => ({
      status,
      identity,
      wallet: walletRef.current,
      connectWallet,
      cancelConnect,
      disconnectWallet,
      setupIdentity,
    }),
    [
      status,
      identity,
      connectWallet,
      cancelConnect,
      disconnectWallet,
      setupIdentity,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used within WalletProvider");
  return v;
}
