// src/felt.ts
//
// Single validator for 0x-hex felt252 strings (chain ids, operator list
// entries, request addresses). All felt-shaped external input goes through
// here so format and size limits live in one place.

import { Fp251 } from "@scure/starknet";

// A felt252 is a Stark field element: 0 <= value < the field prime. Sourced
// from @scure/starknet (Fp251 is the felt252 field; the order of a prime
// field is the prime itself, 2^251 + 17*2^192 + 1) rather than hand-written,
// so the bound can't drift. Distinct from the curve order CURVE.n.
const STARK_PRIME = Fp251.ORDER;

// At most 64 hex digits — the canonical zero-padded StarkNet address width —
// so adversarially long strings are rejected by the regex before BigInt
// parsing. Felt-ness itself is a value property checked against the prime,
// since leading zeros are legitimate.
const HEX_FELT_FORMAT = /^0x[0-9a-fA-F]{1,64}$/;

/** True when `value` is a 0x-prefixed hex string encoding a felt252 (< the Stark prime). */
export function isHexFelt(value: string): boolean {
  return HEX_FELT_FORMAT.test(value) && BigInt(value) < STARK_PRIME;
}

/**
 * True when `entries` contains `addressFelt`, matched on the canonical felt
 * value so a zero-padded entry matches the leading-zero-stripped address
 * callers send. Entries are validated as hex felts at config load, so
 * BigInt() cannot throw.
 */
export function feltListIncludes(
  entries: string[] | undefined,
  addressFelt: bigint
): boolean {
  return entries?.some((entry) => BigInt(entry) === addressFelt) ?? false;
}
