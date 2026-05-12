// Wallet detection + connection via get-starknet.
//
// On `connect()` we open the get-starknet modal (which auto-picks Argent X
// when only one wallet is installed). The returned StarknetWindowObject is
// what we use to call `wallet_requestAccounts`, `wallet_requestChainId`,
// and `wallet_signTypedData` — the last one is the sign-only primitive that
// lets us drive SNIP-9 outside-execution from this app.

import { connect as getStarknetConnect, disconnect as getStarknetDisconnect } from "get-starknet";
import type { StarknetWindowObject } from "get-starknet";
import type { ConnectedWallet } from "./types.ts";

export async function connectWallet(): Promise<ConnectedWallet | null> {
  // `modalMode: "alwaysAsk"` prompts the user every time so they can pick
  // which wallet to use even after a prior connection — clearer for first-
  // time demo users. Switch to "canAsk" later if we want session continuity.
  const wallet = await getStarknetConnect({
    modalMode: "alwaysAsk",
    modalTheme: "dark",
  });
  if (!wallet) return null;

  const accounts = await requestAccounts(wallet);
  if (accounts.length === 0) return null;
  const address = normalizeAddress(accounts[0]);

  const chainId = await requestChainId(wallet);

  return {
    wallet,
    address,
    chainId,
    walletName: wallet.name ?? wallet.id ?? "Wallet",
  };
}

export async function disconnectWallet(): Promise<void> {
  await getStarknetDisconnect({ clearLastWallet: true });
}

async function requestAccounts(wallet: StarknetWindowObject): Promise<string[]> {
  const result = await wallet.request({ type: "wallet_requestAccounts", params: {} });
  return result as string[];
}

async function requestChainId(wallet: StarknetWindowObject): Promise<string> {
  const result = await wallet.request({ type: "wallet_requestChainId" });
  return result as string;
}

// 0x-prefix + lowercase + strip the 1-character "0" padding StarkNet sometimes
// uses (e.g. "0x0123..." → "0x123..."). The padded form fails `BigInt()`
// comparison against the un-padded form when our code path also lowercases.
function normalizeAddress(address: string): string {
  const stripped = address.toLowerCase().replace(/^0x0*/, "");
  return "0x" + (stripped.length > 0 ? stripped : "0");
}
