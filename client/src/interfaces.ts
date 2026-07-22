import type {
  ProviderInterface,
  STRK20_ACTION,
  STRK20_CALL_AND_PROOF,
  STRK20_CALLDATA_ITEM,
} from "starknet";
import type { StarknetAddress } from "@starkware-libs/starknet-privacy-sdk";

/**
 * LOCAL SHIM — remove when `@starknet-io/starknet-types` ships it. The compute-and-invoke sibling of
 * `STRK20_INVOKE_ACTION`: two placeholder-capable calldata arrays that the SDK adapter maps to core's
 * `ComputeAndInvokeDetails.computeAdditionalData` / `invokeAdditionalData`. Modeled here so
 * `Strk20Action` can express core's `computeAndInvoke` uniformly; a real strk20 wallet gains it upstream.
 */
export interface STRK20_COMPUTE_AND_INVOKE_ACTION {
  type: "compute_and_invoke";
  contract: string;
  compute_calldata: STRK20_CALLDATA_ITEM[];
  invoke_calldata: STRK20_CALLDATA_ITEM[];
}

/**
 * The privacy-action currency at the wallet seam: the starknet.js wallet-api `STRK20_ACTION` union
 * widened with the {@link STRK20_COMPUTE_AND_INVOKE_ACTION} shim. Both invoke variants carry
 * placeholder-capable calldata (`STRK20_CALLDATA_ITEM = FELT | placeholder string`), so the builder
 * emits `${openNoteIds[N]}` / `${poolAddress}` placeholders for every wallet, and whoever proves +
 * submits substitutes them (the native wallet at assembly; the SDK adapter before proving).
 */
export type Strk20Action = STRK20_ACTION | STRK20_COMPUTE_AND_INVOKE_ACTION;

/**
 * The wallet seam — the privacy subset of starknet.js `WalletAccountV6`. A get-starknet v6 wallet
 * satisfies it natively (passed to {@link createPrivacyClient} directly); a legacy-SN / EVM wallet is
 * an `SdkWallet` (added upstack) that wraps an injected CallSet `SignerInterface` and proves + submits
 * via the core SDK. The client programs only against this — there is no wallet `kind`, and the dapp
 * constructs the implementation it wants.
 */
export interface PrivacyWallet {
  /** The nonce-independent commitment `hash(identity_key, dappName)`, for sub-account resolution. */
  partialCommitment(dappName: string): Promise<bigint>;
  /** Prove actions into a submittable `{ call, proof }` (`simulate` ⇒ empty proof); does not broadcast. */
  strk20PrepareInvoke(actions: Strk20Action[], simulate?: boolean): Promise<STRK20_CALL_AND_PROOF>;
  /** Prove + broadcast the actions in one step, returning the tx hash. */
  strk20InvokeTransaction(actions: Strk20Action[]): Promise<{ transaction_hash: string }>;
}

/**
 * Dependencies for {@link createPrivacyClient}. The dapp constructs the {@link PrivacyWallet} it wants
 * (a get-starknet v6 wallet directly, or — upstack — an `SdkWallet` over a signer). `provider` +
 * `subAccountAnonymizerAddress` are the client's read context: it queries the anonymizer view (through
 * the provider) with `wallet.partialCommitment(dappName)` to resolve sub-account addresses.
 */
export interface PrivacyClientConfig {
  /** The wallet — signs, proves, and submits privacy operations. */
  wallet: PrivacyWallet;
  /** Provider for the sub-account anonymizer view call. */
  provider: ProviderInterface;
  /** The sub-account anonymizer contract the client queries for sub-account addresses. */
  subAccountAnonymizerAddress: StarknetAddress;
}

/**
 * A dapp client for Starknet privacy — an opaque handle for now. The operation builder (`build()`)
 * and sub-account address resolution (`addresses()`) are added in later changesets; `partialCommitment`
 * is not public (the client calls `wallet.partialCommitment` internally when resolving addresses).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PrivacyClient {}
