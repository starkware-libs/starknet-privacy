/**
 * Type conversion utilities - thin wrappers around starknet.js encode/num modules.
 */

import { encode, num, BigNumberish } from "starknet";

/** Any value that can be converted to bigint, bytes, or hex */
export type Numeric = BigNumberish | Uint8Array;

// ============ To BigInt ============

/** Convert Numeric to bigint */
export function toBigInt(value: Numeric): bigint {
  if (value instanceof Uint8Array) {
    return encode.uint8ArrayToBigInt(value);
  }
  return num.toBigInt(value);
}

// ============ To Bytes ============

/** Convert Numeric to 32-byte Uint8Array (zero-padded) */
export function toBytes(value: Numeric): Uint8Array {
  const n = toBigInt(value);
  const hex = n.toString(16).padStart(64, "0");
  return encode.hexStringToUint8Array(hex);
}

// ============ To Hex ============

/** Convert Numeric to hex string (no 0x prefix). Strings are treated as UTF-8. */
export function toHex(value: Numeric): string {
  if (value instanceof Uint8Array) {
    return encode.buf2hex(value);
  }
  if (typeof value === "bigint") {
    return value.toString(16);
  }
  if (typeof value === "number") {
    return value.toString(16);
  }
  if (typeof value === "string") {
    // Numeric strings (hex or decimal) are converted to numbers by toBigInt
    // Non-numeric strings would throw, so encode as UTF-8 for safety
    if (value.startsWith("0x") || value.startsWith("0X") || /^\d+$/.test(value)) {
      return num.toBigInt(value).toString(16);
    }
    return encode.buf2hex(encode.utf8ToArray(value));
  }
  // Fallback for any other BigNumberish
  return num.toBigInt(value).toString(16);
}
