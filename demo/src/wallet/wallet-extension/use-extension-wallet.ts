// React state hook for the connected wallet extension.
//
// Two responsibilities:
//   1. Track the currently connected wallet (`ConnectedWallet | null`) and
//      expose connect / disconnect actions.
//   2. Derive the viewing key on first connect (one wallet prompt) and
//      cache it via `derive-viewing-key.ts`. Failures surface as state the
//      UI can render — we don't throw.
//
// All other state (private-key accounts, the JSON-paste flow) lives in the
// existing `useAccounts` hook. This hook is purely additive — when no wallet
// is connected, the rest of the app behaves exactly as before.

import { useCallback, useEffect, useState } from "react";
import { connectWallet, disconnectWallet } from "./connect.ts";
import {
  clearCachedViewingKey,
  deriveViewingKeyFromWallet,
} from "./derive-viewing-key.ts";
import type { ConnectedWallet } from "./types.ts";

export type ExtensionState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "deriving"; wallet: ConnectedWallet }
  | {
      kind: "ready";
      wallet: ConnectedWallet;
      viewingKey: bigint;
      /** Scalar used as the SDK's Signer for proof generation. Derived from
       *  the wallet's typed-data signature; recomputable on a fresh session. */
      proofPrivateKey: bigint;
    }
  | { kind: "error"; message: string; wallet?: ConnectedWallet };

export function useExtensionWallet(poolAddress: string): {
  state: ExtensionState;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
} {
  const [state, setState] = useState<ExtensionState>({ kind: "idle" });

  // If the user reloads while connected, we lose the wallet object (the
  // get-starknet handshake has to re-run). We don't auto-reconnect — leaving
  // it to the user keeps the wallet prompt explicit. The cached viewing key
  // is still available, so re-connecting won't prompt for derivation again.

  const connect = useCallback(async () => {
    setState({ kind: "connecting" });
    let wallet: ConnectedWallet | null;
    try {
      wallet = await connectWallet();
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!wallet) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "deriving", wallet });

    const derivation = await deriveViewingKeyFromWallet(wallet, poolAddress);
    if (derivation.kind === "ok") {
      setState({
        kind: "ready",
        wallet,
        viewingKey: derivation.viewingKey,
        proofPrivateKey: derivation.proofPrivateKey,
      });
    } else if (derivation.kind === "rejected") {
      setState({
        kind: "error",
        message: "You declined to sign the viewing-key derivation message. Reconnect to retry.",
        wallet,
      });
    } else {
      setState({ kind: "error", message: derivation.message, wallet });
    }
  }, [poolAddress]);

  const disconnect = useCallback(async () => {
    if (state.kind === "ready" || state.kind === "deriving" || state.kind === "error") {
      const wallet = state.wallet;
      if (wallet) {
        clearCachedViewingKey(wallet.chainId, poolAddress, wallet.address);
      }
    }
    try {
      await disconnectWallet();
    } catch {
      // get-starknet sometimes throws on disconnect for wallets that don't
      // implement it — fine, we're tearing down our own state anyway.
    }
    setState({ kind: "idle" });
  }, [state, poolAddress]);

  // Listen for the wallet's `accountsChanged` event so disconnecting in the
  // extension itself reflects in our UI. (We just go back to idle and let
  // the user reconnect explicitly.)
  useEffect(() => {
    if (state.kind !== "ready" && state.kind !== "deriving" && state.kind !== "error") return;
    const wallet = state.wallet;
    if (!wallet) return;
    function onAccountsChanged(accounts?: string[]) {
      if (!accounts || accounts.length === 0) {
        setState({ kind: "idle" });
      }
    }
    wallet.wallet.on("accountsChanged", onAccountsChanged);
    return () => wallet.wallet.off("accountsChanged", onAccountsChanged);
  }, [state]);

  return { state, connect, disconnect };
}
