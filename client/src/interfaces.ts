import type {
  Call,
  EstimateFeeResponseOverhead,
  ProviderInterface,
  STRK20_ACTION,
  STRK20_CALL_AND_PROOF,
  STRK20_CALLDATA_ITEM,
  STRK20_PROOF,
  UniversalDetails,
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
  /** Broadcast `calls` (the prepared strk20 call plus any surrounding calls) with `proof`. */
  executeWithProof(calls: Call[], proof?: STRK20_PROOF): Promise<{ transaction_hash: string }>;
  /** Estimate the fee for `calls` on the node — the wallet is the account, so no sender is passed. */
  estimateInvokeFee(
    calls: Call[],
    details?: UniversalDetails
  ): Promise<EstimateFeeResponseOverhead>;
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

/** The result of broadcasting a transaction: the Starknet transaction hash. */
export interface SubmitResult {
  transaction_hash: string;
}

/**
 * Extra Starknet calls to run around the private invoke. `preCalls` run before it (e.g. a deposit's
 * `approve`, which has no depositor privacy anyway); `postCalls` after. The builder supplies these.
 */
export interface SubmitOptions {
  preCalls?: Call[];
  postCalls?: Call[];
}

/**
 * A dapp client for Starknet privacy. It drives the injected {@link PrivacyWallet} — for a native
 * get-starknet v6 wallet that is a direct pass-through; for an `SdkWallet` (upstack) it routes
 * through the core SDK + paymaster. The ergonomic operation builder (`build()`) and sub-account
 * reads (`addresses()`) are layered on top of this low-level entry point in later changesets.
 */
export interface PrivacyClient {
  /**
   * Prove and broadcast `actions` through the wallet, returning the transaction hash. With no
   * surrounding calls this is the combined `strk20InvokeTransaction`; with `preCalls`/`postCalls`
   * it prepares the proof and submits the assembled calls via `executeWithProof`.
   */
  submit(
    actions: Strk20Action[],
    options?: SubmitOptions & { simulate?: false }
  ): Promise<SubmitResult>;
  /**
   * Prove `actions` in simulate mode (empty proof) and estimate the assembled invoke's fee on the
   * node — no broadcast. Returns a standard Starknet fee estimate, for a quote or preview.
   */
  submit(
    actions: Strk20Action[],
    options: SubmitOptions & { simulate: true }
  ): Promise<EstimateFeeResponseOverhead>;
}
