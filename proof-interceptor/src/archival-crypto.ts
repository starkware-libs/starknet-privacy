import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import nacl from "tweetnacl";
import { CallData } from "starknet";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";

// @ts-expect-error — tweetnacl-sealedbox-js has no type declarations
import sealedbox from "tweetnacl-sealedbox-js";

const HKDF_SALT = "starknet-privacy-archival";
const HKDF_INFO = "x25519-key";

const ACTIONS_TYPE =
  "core::array::Span::<privacy::actions::ClientAction>" as const;
const callDataDecoder = new CallData(PrivacyPoolABI);

export interface EncryptionSeed {
  type: "viewingkey" | "sender";
  seed: string;
}

/**
 * Validates that the inner calldata (after user_addr and viewing_key) decodes
 * as privacy pool client actions via the contract ABI.
 */
function isPrivacyPoolCalldata(innerCalldata: string[]): boolean {
  if (innerCalldata.length < 3) return false;
  try {
    callDataDecoder.decodeParameters(ACTIONS_TYPE, innerCalldata.slice(2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts the encryption seed from transaction calldata.
 *
 * For privacy pool transactions — single-call (calldata[0]==="0x1") whose
 * inner calldata successfully ABI-decodes as privacy pool actions — uses
 * the viewing key at inner calldata index 1 (calldata[5]).
 *
 * Otherwise falls back to senderAddress.
 */
export function extractEncryptionSeed(
  calldata: string[],
  senderAddress: string
): EncryptionSeed {
  if (calldata.length >= 7 && calldata[0] === "0x1") {
    const innerCalldataLength = parseInt(calldata[3], 16);
    if (!Number.isNaN(innerCalldataLength) && innerCalldataLength >= 3) {
      const innerCalldata = calldata.slice(4, 4 + innerCalldataLength);
      if (isPrivacyPoolCalldata(innerCalldata)) {
        return { type: "viewingkey", seed: innerCalldata[1] };
      }
    }
  }
  return { type: "sender", seed: senderAddress };
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
