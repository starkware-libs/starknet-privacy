// src/felt.ts
//
// Single validator for 0x-hex felt252 strings (chain ids, operator list
// entries, request addresses). All felt-shaped external input goes through
// here so format and size limits live in one place.

import { Fp251 } from "@scure/starknet";

// The felt252 field prime, 2^251 + 17*2^192 + 1 (not the curve order CURVE.n).
const STARK_PRIME = Fp251.ORDER;

// Up to 64 hex digits (the zero-padded address width): rejects adversarially
// long strings before BigInt parsing while allowing leading zeros.
const HEX_FELT_FORMAT = /^0x[0-9a-fA-F]{1,64}$/;

/** True when `value` is a 0x-prefixed hex string encoding a felt252 (< the Stark prime). */
export function isHexFelt(value: string): boolean {
  return HEX_FELT_FORMAT.test(value) && BigInt(value) < STARK_PRIME;
}

/**
 * True when `entries` contains `addressFelt`, matched on the canonical felt
 * value so zero-padded and stripped forms are equal. Entries must be valid
 * hex felts.
 */
export function feltListIncludes(
  entries: string[] | undefined,
  addressFelt: bigint
): boolean {
  return entries?.some((entry) => BigInt(entry) === addressFelt) ?? false;
}
