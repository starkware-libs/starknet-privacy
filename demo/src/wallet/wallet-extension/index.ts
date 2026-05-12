// Public surface of the wallet-extension module. Other parts of the wallet
// should import from here only — keeps the internal structure free to evolve.

export { ExtensionAccount } from "./extension-account.ts";
export { createRelayerAccount, RELAYER } from "./relayer.ts";
export { useExtensionWallet, type ExtensionState } from "./use-extension-wallet.ts";
export type { ConnectedWallet } from "./types.ts";
