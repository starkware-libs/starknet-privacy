import type {
  BigNumberish,
  Call,
  CallDetails,
  EstimateFeeResponseOverhead,
  ProviderInterface,
  STRK20_ACTION,
  STRK20_CALL_AND_PROOF,
  STRK20_CALLDATA_ITEM,
  STRK20_PROOF,
  UniversalDetails,
} from "starknet";
import type { PrivateRegistry, StarknetAddress } from "@starkware-libs/starknet-privacy-sdk";

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
 * Proves {@link Strk20Action}s into a submittable `{ call, proof }` and resolves the user's partial
 * commitment. This is strk20-specific (not a general prover). Crucially, the viewing key needed to
 * prove and to derive the partial commitment is the prover's own concern — it is retrieved inside the
 * implementation, never passed in by the dapp. That keeps a future on-device prover free to fetch the
 * key locally (more secure, and shareable across dapps).
 */
export interface Strk20Prover {
  /** The nonce-independent commitment `hash(identity_key, dappName)` (derived from the viewing key). */
  partialCommitment(dappName: string): Promise<bigint>;
  /** Prove `actions` into `{ call, proof }`; `simulate` yields an empty proof. Does not broadcast. */
  prove(actions: Strk20Action[], simulate?: boolean): Promise<STRK20_CALL_AND_PROOF>;
}

/**
 * Persists the core note registry between transactions so proofs see previously-created notes. A
 * fresh user with nothing stored returns an empty registry; the SDK path saves the updated registry
 * after a proven (non-simulated) transaction.
 */
export interface PrivacyStorage {
  loadRegistry(): Promise<PrivateRegistry>;
  saveRegistry(registry: PrivateRegistry): Promise<void>;
}

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
  /** The user's Starknet account address — the default recipient for self-directed ops (open notes). */
  userAddress: StarknetAddress;
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
  /** Open a fluent operation builder that compiles into one privacy transaction. */
  build(): PrivacyBuilder;
}

/** The transaction-time values an invoke call builder may reference, as wallet-resolved placeholders. */
export interface PrivacyInvokeArgs {
  /** Placeholder per open note created in this transaction: `openNoteIds[N]` is the Nth open note's id. */
  openNoteIds: string[];
  /** Placeholder for the privacy pool address. */
  poolAddress: string;
}

/** Builds a plain invoke's target + calldata (which may embed {@link PrivacyInvokeArgs} placeholders). */
export type PrivacyInvokeCallBuilder = (args: PrivacyInvokeArgs) => CallDetails;

/** The target + compute/invoke calldata a compute-and-invoke produces, for the two-stage invocation. */
export interface PrivacyComputeInvokeDetails {
  contractAddress: string;
  computeCalldata: STRK20_CALLDATA_ITEM[];
  invokeCalldata: STRK20_CALLDATA_ITEM[];
}

/** Builds a compute-and-invoke's target + two calldata arrays (may embed placeholders). */
export type PrivacyComputeInvokeCallBuilder = (
  args: PrivacyInvokeArgs
) => PrivacyComputeInvokeDetails;

/** Token-scoped operations, opened by {@link PrivacyBuilder.with}. Each queues an action + chains. */
export interface PrivacyTokenBuilder {
  /** Deposit `amount` of the token from the user's public balance into the pool (always to self). */
  deposit(output: { amount: BigNumberish }): PrivacyBuilder;
  /** Withdraw `amount` of the token from the pool to `recipient`. */
  withdraw(output: { amount: BigNumberish; recipient: StarknetAddress }): PrivacyBuilder;
  /** Privately transfer `amount` of the token to `recipient` inside the pool. */
  transfer(output: { amount: BigNumberish; recipient: StarknetAddress }): PrivacyBuilder;
  /** Create an open note for the token owned by the user — its amount is settled later in the same tx. */
  createOpenNote(): PrivacyBuilder;
}

/**
 * A fluent builder for one privacy transaction. Token operations are opened with `with(token)`;
 * `invoke` / `invokeWithComputation` run a contract after the private operations. Every method queues
 * an action and returns the builder; `submit` proves + broadcasts the whole set, `simulate` returns a
 * fee estimate without broadcasting.
 */
export interface PrivacyBuilder {
  /** Open token-scoped operations for `token`. */
  with(token: StarknetAddress): PrivacyTokenBuilder;
  /** Queue a contract invocation that runs after the private operations. */
  invoke(callBuilder: PrivacyInvokeCallBuilder): PrivacyBuilder;
  /** Queue a two-stage compute-and-invoke that runs after the private operations. */
  invokeWithComputation(callBuilder: PrivacyComputeInvokeCallBuilder): PrivacyBuilder;
  /** Prove and broadcast the queued operations, returning the transaction hash. */
  submit(): Promise<SubmitResult>;
  /** Prove the queued operations in simulate mode and return the node fee estimate. */
  simulate(): Promise<EstimateFeeResponseOverhead>;
}
