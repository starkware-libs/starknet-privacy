import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import nacl from "tweetnacl";

// @ts-expect-error — tweetnacl-sealedbox-js has no type declarations
import sealedbox from "tweetnacl-sealedbox-js";

const HKDF_SALT = "starknet-privacy-archival";
const HKDF_INFO = "x25519-key";

export interface EncryptionSeed {
  type: "viewingkey" | "sender";
  seed: string;
}

/**
 * Extracts the encryption seed from transaction calldata.
 * For privacy pool transactions (single-call, calldata[0]==="0x1", inner len >= 2),
 * uses the viewing key (inner calldata[1]).
 * Otherwise falls back to senderAddress.
 */
export function extractEncryptionSeed(
  calldata: string[],
  senderAddress?: string
): EncryptionSeed {
  if (calldata.length >= 6 && calldata[0] === "0x1") {
    const innerLen = parseInt(calldata[3], 16);
    if (!Number.isNaN(innerLen) && innerLen >= 2) {
      return { type: "viewingkey", seed: calldata[5] };
    }
  }
  return { type: "sender", seed: senderAddress ?? "0x0" };
}

/**
 * Derives a deterministic X25519 key pair from a hex seed using HKDF-SHA256.
 */
export function deriveKeyPair(hexSeed: string): nacl.BoxKeyPair {
  const seedBytes = hexToBytes(hexSeed);
  const derived = hkdf(
    sha256,
    seedBytes,
    new TextEncoder().encode(HKDF_SALT),
    new TextEncoder().encode(HKDF_INFO),
    32
  );
  return nacl.box.keyPair.fromSecretKey(new Uint8Array(derived));
}

/**
 * Encrypts plaintext using X25519 sealed box (anonymous sender).
 */
export function encryptForArchival(
  plaintext: Uint8Array,
  publicKey: Uint8Array
): Uint8Array {
  return sealedbox.seal(plaintext, publicKey) as Uint8Array;
}

/**
 * Decrypts sealed box ciphertext. Returns null on failure.
 */
export function decryptArchival(
  ciphertext: Uint8Array,
  publicKey: Uint8Array,
  secretKey: Uint8Array
): Uint8Array | null {
  return (
    (sealedbox.open(ciphertext, publicKey, secretKey) as Uint8Array | null) ??
    null
  );
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  const padded = cleaned.length % 2 === 1 ? "0" + cleaned : cleaned;
  const bytes = new Uint8Array(padded.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(padded.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
