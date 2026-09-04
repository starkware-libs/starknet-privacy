// src/pool-transaction.ts
import { CairoCustomEnum, CallData } from "starknet";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import type { ProveTxnV3 } from "./types.js";

const ACTIONS_TYPE =
  "core::array::Span::<privacy::actions::ClientAction>" as const;

/** The pool ABI's coder, shared by every module that encodes or decodes pool calldata. */
export const poolCallData = new CallData(PrivacyPoolABI);

/**
 * Returns true iff the transaction is a single-call INVOKE whose target
 * contract matches `poolAddress`.
 *
 * Expected calldata layout for a single-call INVOKE:
 *   [0] call_count          — must normalize to "0x1"
 *   [1] contract_address    — must match `poolAddress`
 *   [2] selector             — entrypoint selector (not checked here)
 *   [3] inner_calldata_len   — length of inner calldata
 *   [4..] inner calldata
 *
 * Multi-call batches (call_count !== 1) are not considered pool
 * transactions even if one of the inner calls targets the pool, because
 * single-call shape is required to decode the inner calldata.
 *
 * All hex felts are normalized before comparison so attackers can't bypass
 * the check with variants like "0X1", "0x01", "0x001", or mixed-case digits.
 */
export function isSinglePoolCall(
  transaction: ProveTxnV3,
  poolAddress: string
): boolean {
  const calldata = transaction.calldata;
  if (calldata.length < 7 || normalizeFelt(calldata[0]) !== "0x1") return false;
  return normalizeFelt(calldata[1]) === normalizeFelt(poolAddress);
}

/** A pool call's decoded inner calldata: `[user_addr, user_private_key, ...client actions]`. */
export interface PoolCallActions {
  /** `user_addr`, normalized. */
  userAddress: string;
  /**
   * `user_private_key`, the user's viewing key, which the pool feeds to `compute_identity_key`. It is
   * `null` when that felt does not parse. Only shadow account derivation reads it, so an unparseable
   * one costs only that derivation.
   *
   * A secret: it identifies the user and derives their shadow accounts, so it must never be logged,
   * echoed into a verdict, or forwarded anywhere.
   */
  viewingKey: bigint | null;
  /** The client actions the pool is asked to compile, one enum per action. */
  actions: CairoCustomEnum[];
}

/**
 * Decodes the client actions of a single direct call to the pool, using the
 * contract ABI from the SDK.
 *
 * Returns `null` for a transaction that is not such a call, and for calldata
 * that does not decode. Screening garbage is pointless, since a transaction the
 * pool cannot parse reverts on its own.
 *
 * The length prefix and the action span are read here rather than through the SDK's own
 * `extractExecuteViewCalldata`, which converts the prefix with an unguarded `Number(BigInt(...))`.
 * Every felt below is caller-supplied, so each one is checked before it is used: a prefix that is
 * not a number, or shorter than the two leading felts, ends the decode instead of slicing.
 */
export function decodeClientActions(
  transaction: ProveTxnV3,
  poolAddress: string
): PoolCallActions | null {
  if (!isSinglePoolCall(transaction, poolAddress)) return null;

  const calldata = transaction.calldata;
  const innerCalldataLength = parseInt(calldata[3], 16);
  if (Number.isNaN(innerCalldataLength) || innerCalldataLength < 3) return null;

  const innerCalldata = calldata.slice(4, 4 + innerCalldataLength);
  try {
    const actions = poolCallData.decodeParameters(
      ACTIONS_TYPE,
      innerCalldata.slice(2)
    ) as CairoCustomEnum[];
    return {
      userAddress: normalizeFelt(innerCalldata[0]),
      viewingKey: parseFelt(innerCalldata[1]),
      actions,
    };
  } catch {
    return null;
  }
}

/** The felt as a bigint, or `null` if it does not parse. */
export function parseFelt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Canonicalizes a hex felt252 string for equality comparison. Lowercases the
 * input (so "0X" / "0x" prefixes and "ABC" / "abc" digits all normalize the
 * same), strips the optional "0x" prefix, removes leading zeros, then
 * re-attaches "0x". Returns "0x0" for the zero value.
 */
export function normalizeFelt(value: string): string {
  const lower = value.toLowerCase();
  const hex = lower.startsWith("0x") ? lower.slice(2) : lower;
  return "0x" + (hex.replace(/^0+/, "") || "0");
}
