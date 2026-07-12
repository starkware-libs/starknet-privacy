// @starkware-libs/starknet-privacy-client — dapp client for Starknet privacy.
//
// Resolves sub-accounts, bridges Starknet/EVM wallet signing, and builds privacy operations
// over @starkware-libs/starknet-privacy-sdk. More of the public API is added in later changesets.
export { createPrivacyClient } from "./client.js";
export type {
  PrivacyClient,
  PrivacyClientConfig,
  PrivacyWallet,
  STRK20_COMPUTE_AND_INVOKE_ACTION,
  Strk20Action,
} from "./interfaces.js";
