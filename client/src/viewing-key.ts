import { ec, num } from "starknet";
import type { BigNumberish } from "starknet";
import type { ViewingKey, ViewingKeyProvider } from "@starkware-libs/starknet-privacy-sdk";

const poseidonHashMany = ec.starkCurve.poseidonHashMany;

/**
 * Stark curve order and its half. A canonical viewing key is a non-zero scalar below the half-order
 * (`privacy::utils::is_canonical_key`) — the only form the privacy pool accepts as a user key.
 */
const CURVE_ORDER = ec.starkCurve.CURVE.n;
const HALF_ORDER = CURVE_ORDER >> 1n;

/**
 * Poseidon rounds folded into the derivation. The per-account salt (below) is what defeats shared
 * rainbow tables; the rounds add a linear brute-force cost on top. Poseidon in JS is ~100× slower
 * per op than SHA-256, so this modest count is wall-clock-comparable to a large SHA-256 KDF (~300ms
 * one-time) without making key derivation painful.
 */
const KDF_ROUNDS = 1000;

/** Bytes packed per felt: a felt holds 251 bits, so 31 bytes (248 bits) always fits. */
const BYTES_PER_FELT = 31;

/** Pack a UTF-8 passphrase into big-endian felt limbs (at least one, so an empty string still hashes). */
function passphraseToFelts(passphrase: string): bigint[] {
  const bytes = new TextEncoder().encode(passphrase);
  const felts: bigint[] = [];
  for (let offset = 0; offset < bytes.length; offset += BYTES_PER_FELT) {
    let limb = 0n;
    for (const byte of bytes.subarray(offset, offset + BYTES_PER_FELT)) {
      limb = (limb << 8n) | BigInt(byte);
    }
    felts.push(limb);
  }
  return felts.length > 0 ? felts : [0n];
}

/**
 * Derives a viewing key from a user passphrase. The passphrase is salted with the account `address`
 * — so the same passphrase yields a different key per account, defeating shared rainbow tables — and
 * folded through {@link KDF_ROUNDS} Poseidon rounds (each re-mixing the salt) to make brute-forcing
 * costly. The result is a canonical viewing key (a non-zero scalar below the Stark curve half-order),
 * which the privacy pool accepts directly.
 */
export function deriveViewingKey(passphrase: string, address: BigNumberish): bigint {
  const salt = num.toBigInt(address);
  let key = poseidonHashMany([...passphraseToFelts(passphrase), salt]);
  for (let round = 1; round < KDF_ROUNDS; round++) {
    key = poseidonHashMany([key, salt]);
  }
  return canonicalViewingKey(key);
}

/**
 * Folds a KDF output into a canonical viewing key. The pool rejects a non-canonical user key
 * (`privacy::utils::is_canonical_key`: `key < HALF_ORDER`), so reduce into the scalar field and
 * mirror the upper half below the half-order. Zero and the ~2^-250 fixed points fall back to 1, so
 * every passphrase yields a usable, non-zero key.
 */
function canonicalViewingKey(key: bigint): bigint {
  let scalar = key % CURVE_ORDER;
  if (scalar >= HALF_ORDER) scalar = CURVE_ORDER - scalar;
  return scalar === 0n || scalar >= HALF_ORDER ? 1n : scalar;
}

/**
 * A {@link ViewingKeyProvider} backed by {@link deriveViewingKey}. Derivation is lazy and memoized —
 * the (relatively costly) KDF runs on first use, not at construction, and the result is cached in
 * memory. This is the default viewing-key source for the SDK-backed prover: recoverable from the
 * passphrase, never written to disposable storage.
 */
export function passphraseViewingKeyProvider(
  passphrase: string,
  address: BigNumberish
): ViewingKeyProvider {
  let cached: ViewingKey | undefined;
  return { getViewingKey: async () => (cached ??= deriveViewingKey(passphrase, address)) };
}
