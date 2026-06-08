import { useCallback, useState } from "react";
import type { Token } from "../types";
import {
  buildErc20Transfer,
  buildEthTransfer,
  requestRealQuote,
} from "../lib/eth-send";

export type EthSendStatus =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "awaiting-signature"; depositAddress: string }
  | { kind: "sent"; txHash: string; depositAddress: string }
  | { kind: "error"; message: string };

export interface SendArgs {
  fromToken: Token;
  toToken: Token;
  amountIn: bigint;
  refundTo: string;
  recipient: string;
  /** Optional slippage override; default matches the 50 bps used elsewhere. */
  slippageBps?: number;
}

interface UseEthSendResult {
  status: EthSendStatus;
  send: (args: SendArgs) => Promise<string | null>;
  reset: () => void;
}

const DEFAULT_SLIPPAGE_BPS = 50;

export function useEthSend(): UseEthSendResult {
  const [status, setStatus] = useState<EthSendStatus>({ kind: "idle" });

  const reset = useCallback(() => setStatus({ kind: "idle" }), []);

  const send = useCallback(async (args: SendArgs): Promise<string | null> => {
    const provider = typeof window !== "undefined" ? window.ethereum : undefined;
    if (!provider) {
      setStatus({ kind: "error", message: "No Ethereum wallet detected" });
      return null;
    }

    setStatus({ kind: "quoting" });
    let depositAddress: string;
    try {
      const quote = await requestRealQuote({
        from: args.fromToken,
        to: args.toToken,
        amountIn: args.amountIn,
        slippageBps: args.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
        recipient: args.recipient,
        refundTo: args.refundTo,
      });
      if (!quote) {
        setStatus({ kind: "error", message: "Swap pair not supported" });
        return null;
      }
      depositAddress = quote.depositAddress;
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
      return null;
    }

    setStatus({ kind: "awaiting-signature", depositAddress });

    // Sender comes from the wallet's currently-selected account; failing fast
    // here keeps the eth_sendTransaction error path readable.
    const accountsRaw = await provider
      .request({ method: "eth_accounts" })
      .catch((err) => err);
    const accounts = Array.isArray(accountsRaw) ? (accountsRaw as string[]) : [];
    const from = accounts[0];
    if (!from) {
      setStatus({ kind: "error", message: "Wallet not connected" });
      return null;
    }

    const tx =
      args.fromToken.symbol === "ETH"
        ? {
            from,
            ...buildEthTransfer({
              to: depositAddress,
              valueWei: args.amountIn,
            }),
          }
        : {
            from,
            ...buildErc20Transfer({
              token: tokenAddressOrThrow(args.fromToken),
              to: depositAddress,
              amount: args.amountIn,
            }),
          };

    try {
      const txHash = (await provider.request({
        method: "eth_sendTransaction",
        params: [tx],
      })) as string;
      setStatus({ kind: "sent", txHash, depositAddress });
      return txHash;
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
      return null;
    }
  }, []);

  return { status, send, reset };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

// The ERC-20 contract address travels on `Token` for non-native assets. We
// don't have a typed field today, so callers must attach it as `address`.
function tokenAddressOrThrow(token: Token): string {
  const maybe = (token as unknown as { address?: string }).address;
  if (!maybe) {
    throw new Error(`Token ${token.symbol} is missing an ERC-20 address`);
  }
  return maybe;
}
