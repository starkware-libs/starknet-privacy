import { useEthWallet, type EthWalletStatus } from "./useEthWallet";
import {
  useSolanaWallet,
  type SolanaWalletStatus,
} from "./useSolanaWallet";

export type SourceWalletKind = "evm" | "solana" | "copy-paste";

// Scoped to mainnet Ethereum for the hackathon — Metamask doesn't have to
// network-switch in the demo flow. Re-expand when we open more chains.
const EVM_CHAINS = new Set(["eth"]);

export function sourceWalletKind(chainTag: string): SourceWalletKind {
  if (EVM_CHAINS.has(chainTag)) return "evm";
  if (chainTag === "sol") return "solana";
  return "copy-paste";
}

export interface UnifiedSourceWallet {
  kind: SourceWalletKind;
  /** Display label, e.g. "Metamask", "Phantom", or "copy-paste". */
  walletLabel: string;
  status:
    | EthWalletStatus
    | SolanaWalletStatus
    | { kind: "no-wallet" }
    | { kind: "idle" };
  /** True iff the wallet is installed. */
  available: boolean;
  /** True iff connected (covers both kinds). */
  connected: boolean;
  address: string | null;
  connect: () => Promise<void>;
  disconnect: () => void | Promise<void>;
}

export function useSourceWallet(chainTag: string): UnifiedSourceWallet {
  // Both hooks always run; the unused one stays idle (no extension calls
  // until the user clicks connect). This keeps the hooks-rules happy across
  // chainTag changes.
  const eth = useEthWallet();
  const sol = useSolanaWallet();
  const kind = sourceWalletKind(chainTag);

  if (kind === "evm") {
    return {
      kind,
      walletLabel: "Metamask",
      status: eth.status,
      available: eth.status.kind !== "no-wallet",
      connected: eth.status.kind === "connected",
      address: eth.status.kind === "connected" ? eth.status.address : null,
      connect: eth.connect,
      disconnect: eth.disconnect,
    };
  }
  if (kind === "solana") {
    return {
      kind,
      walletLabel: "Phantom",
      status: sol.status,
      available: sol.status.kind !== "no-wallet",
      connected: sol.status.kind === "connected",
      address: sol.status.kind === "connected" ? sol.status.address : null,
      connect: sol.connect,
      disconnect: sol.disconnect,
    };
  }
  return {
    kind,
    walletLabel: "copy-paste",
    status: { kind: "idle" },
    available: true,
    connected: false,
    address: null,
    connect: async () => {},
    disconnect: () => {},
  };
}
