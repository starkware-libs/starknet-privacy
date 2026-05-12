import { useCallback, useState } from "react";
import { Connection, type Transaction } from "@solana/web3.js";
import type { Token } from "../types";
import {
  buildSolTransfer,
  requestRealQuote,
} from "../lib/sol-send";
import { SOLANA_MAINNET_RPC_URL } from "../lib/solana-rpc";

// Minimal subset of Phantom's provider surface used by this hook. We declare
// it locally rather than redeclaring `window.solana` — `useSolanaWallet.ts`
// already augments `Window` with a wider shape, and TypeScript merges
// interface declarations rather than unioning them. We access the global
// through an unknown-cast and narrow with the structural shape below.
interface PhantomSendProvider {
  publicKey?: { toString: () => string } | null;
  signAndSendTransaction: (
    transaction: Transaction,
  ) => Promise<{ signature: string }>;
}

function hasSignAndSend(value: unknown): value is PhantomSendProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { signAndSendTransaction?: unknown })
      .signAndSendTransaction === "function"
  );
}

function detectPhantom(): PhantomSendProvider | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    solana?: unknown;
    phantom?: { solana?: unknown };
  };
  const candidate = win.phantom?.solana ?? win.solana;
  return hasSignAndSend(candidate) ? candidate : null;
}

export type SolanaSendStatus =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "awaiting-signature"; depositAddress: string }
  | { kind: "sent"; signature: string; depositAddress: string }
  | { kind: "error"; message: string; depositAddress?: string };

export interface SendArgs {
  fromToken: Token;
  /** Destination token — required to ask 1Click for a real quote. */
  toToken: Token;
  amountIn: bigint;
  slippageBps: number;
  /** Per-swap refund mailbox (origin chain). */
  refundTo: string;
  /** Per-swap output mailbox (destination chain). */
  recipient: string;
}

export interface UseSolanaSendResult {
  status: SolanaSendStatus;
  send: (args: SendArgs) => Promise<string>;
  reset: () => void;
}

export function useSolanaSend(): UseSolanaSendResult {
  const [status, setStatus] = useState<SolanaSendStatus>({ kind: "idle" });

  const reset = useCallback(() => {
    setStatus({ kind: "idle" });
  }, []);

  const send = useCallback(async (args: SendArgs): Promise<string> => {
    const provider = detectPhantom();
    if (!provider) {
      const message = "Phantom wallet not detected";
      setStatus({ kind: "error", message });
      throw new Error(message);
    }
    const from = provider.publicKey?.toString();
    if (!from) {
      const message = "Phantom is not connected";
      setStatus({ kind: "error", message });
      throw new Error(message);
    }

    let depositAddress: string | undefined;
    try {
      setStatus({ kind: "quoting" });
      const quote = await requestRealQuote({
        from: args.fromToken,
        to: args.toToken,
        amountIn: args.amountIn,
        slippageBps: args.slippageBps,
        recipient: args.recipient,
        refundTo: args.refundTo,
      });
      depositAddress = quote.depositAddress;

      // Build the transfer first so a malformed deposit address fails before
      // the wallet popup opens.
      const transaction = buildSolTransfer({
        from,
        to: depositAddress,
        lamports: quote.amountIn,
      });

      // Fetch the blockhash as late as possible — it has ~150 slot lifetime
      // and the user is about to hold it open in their wallet UI.
      const connection = new Connection(SOLANA_MAINNET_RPC_URL, "confirmed");
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = blockhash;

      setStatus({ kind: "awaiting-signature", depositAddress });
      const { signature } = await provider.signAndSendTransaction(transaction);
      setStatus({ kind: "sent", signature, depositAddress });
      return signature;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", message, depositAddress });
      throw err;
    }
  }, []);

  return { status, send, reset };
}
