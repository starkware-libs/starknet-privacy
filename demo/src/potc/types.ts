import type { Account, RpcProvider } from "starknet";
import type { DeferredStoreResult, ViewingKey as SDKViewingKey } from "starknet-sdk";

export type Felt = bigint;
export type TxHash = string;

/**
 * A proved-and-stored proof ready for submission.
 *
 * The `callAndProof.call.calldata` is the serialized `Span<ServerAction>` — we
 * forward it to `OtcSettlement.join_trade(trade_id, actions)` rather than to
 * `pool.store_actions(actions)`, attaching the same proof to the transaction.
 * The executor invokes `pool.store_actions` internally with the actions+proof,
 * and on the second join applies both parties' stored actions atomically.
 */
export type Proof = DeferredStoreResult;

export type ViewingKey = SDKViewingKey;

export interface SettlementReceipt {
  tradeId: Felt;
  settledTxHash: TxHash;
  settledBlock: number;
}

/**
 * Parameters for building one side of an OTC trade. Standard naming:
 *   - `offerToken` / `offerAmount`: what THIS party puts in.
 *   - `counterparty`: address of the other party (recipient of our offer).
 *
 * The `askToken` / `askAmount` are not on-chain inputs to this party's proof —
 * they're for off-chain agreement and UI sanity checks. The contract auths
 * each trade leg by `trade_id` only.
 */
export interface BuildProofParams {
  tradeId: Felt;
  offerToken: Felt;
  offerAmount: Felt;
  counterparty: Felt;
  // The counterparty's leg, used to commit (in this party's invoke) to the
  // EncNoteCreated event the counterparty must emit. Both parties use
  // salt = trade_id, so each can predict the other's note and bind the trade
  // to the agreed token+amount.
  askToken: Felt;
  askAmount: Felt;
}

export interface POTCServiceConfig {
  account: Account;
  viewingKey: ViewingKey;
  proverUrl: string;
  discoveryUrl: string;
  poolAddress: Felt;
  /** OtcSettlement contract — implements `join_trade(trade_id, actions)`. */
  executorAddress: Felt;
  /** Defaults to `account` (Account extends RpcProvider in starknet.js v10). */
  provider?: RpcProvider;
}

export interface POTCService {
  /**
   * Builds a single proof for this party's leg of the trade: a private
   * transfer of `offerAmount` of `offerToken` to `counterparty`. Both parties
   * call this independently. Trade terms are pre-agreed off-chain and the
   * contract matches the two legs by `tradeId`.
   */
  buildProof(params: BuildProofParams): Promise<Proof>;

  /**
   * Submits the proof through `OtcSettlement.join_trade(trade_id, actions)`.
   *
   * The executor handles first/second detection internally:
   *   - First call for `trade_id`: stores the actions in the pool (proof
   *     validated at store time) and records the hash under `first_hash`.
   *   - Second call: stores the second party's actions, then atomically
   *     applies both legs in the same on-chain transaction.
   *
   * Returns the submission tx hash; call `awaitSettled` for the final receipt.
   */
  submitProof(tradeId: Felt, proof: Proof): Promise<TxHash>;

  /**
   * Confirms settlement. The current contract emits no event; this resolves
   * once a fresh block is read. Wire up to a real `TradeSettled` event when
   * the contract exposes one.
   */
  awaitSettled(tradeId: Felt, signal?: AbortSignal): Promise<SettlementReceipt>;
}
