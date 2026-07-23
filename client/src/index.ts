// @starkware-libs/starknet-privacy-client — dapp client for Starknet privacy.
//
// Resolves sub-accounts, bridges Starknet/EVM wallet signing, and builds privacy operations
// over @starkware-libs/starknet-privacy-sdk. More of the public API is added in later changesets.
export { createPrivacyClient } from "./client.js";
export { resolveSubAccounts, DEFAULT_ADDRESS_RANGE_END } from "./sub-accounts.js";
export type { ResolveSubAccountsParams, SubAccountAnonymizerContract } from "./sub-accounts.js";
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
  STRK20_SUBACCOUNT_INVOKE_ACTION,
  Strk20Action,
  Strk20Call,
  Strk20CollectPolicy,
  Strk20Prover,
  SubAccountInfo,
  SubAccountsBuilder,
  SubmitOptions,
  SubmitResult,
} from "./interfaces.js";
