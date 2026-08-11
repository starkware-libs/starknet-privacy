// @starkware-libs/starknet-privacy-client — dapp client for Starknet privacy.
//
// Resolves shadow accounts, bridges Starknet/EVM wallet signing, and builds privacy operations
// over @starkware-libs/starknet-privacy-sdk. More of the public API is added in later changesets.
export { createPrivacyClient } from "./client.js";
export { resolveShadowAccounts, DEFAULT_ADDRESS_RANGE_END } from "./shadow-accounts.js";
export type {
  ResolveShadowAccountsParams,
  ShadowAccountAnonymizerContract,
} from "./shadow-accounts.js";
export { SdkWallet } from "./sdk-wallet.js";
export type { SdkWalletConfig } from "./sdk-wallet.js";
export { CorePrivateTransfersProver } from "./strk20-prover.js";
export type { CorePrivateTransfersProverConfig } from "./strk20-prover.js";
export { deriveViewingKey, passphraseViewingKeyProvider } from "./viewing-key.js";
export { AvnuPaymaster, toPaymasterCall, normalizeSignature } from "./paymaster.js";
export type {
  AvnuPaymasterOptions,
  Paymaster,
  PaymasterBuild,
  PaymasterCall,
  PaymasterExecute,
  PaymasterFeeAction,
  PaymasterFeeMode,
  PaymasterQuote,
} from "./paymaster.js";
export type {
  AddressRange,
  PrivacyBuilder,
  PrivacyClient,
  PrivacyClientConfig,
  PrivacyComputeInvokeCallBuilder,
  PrivacyComputeInvokeDetails,
  PrivacyInvokeArgs,
  PrivacyInvokeCallBuilder,
  PrivacyStorage,
  PrivacyTokenBuilder,
  PrivacyWallet,
  STRK20_COMPUTE_AND_INVOKE_ACTION,
  STRK20_SHADOW_ACCOUNT_INVOKE_ACTION,
  Strk20Action,
  Strk20Call,
  Strk20CollectPolicy,
  Strk20Prover,
  ShadowAccountInfo,
  ShadowAccountsBuilder,
  SubmitOptions,
  SubmitResult,
} from "./interfaces.js";
