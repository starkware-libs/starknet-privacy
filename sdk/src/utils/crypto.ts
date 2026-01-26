import { ec, encode, num, BigNumberish } from "starknet";
import type { StarknetAddress } from "../interfaces.js";

// ============ Hash Types ============

export type Hash = bigint;
export type ChannelKey = bigint;
export type PublicKey = BigNumberish;
export type PrivateKey = BigNumberish;

// ============ Hash Function ============

/**
 * Convert a short string (up to 31 chars) to a felt, matching Cairo's short string literals.
 * e.g., 'channel_key:v1' in Cairo becomes the same bigint.
 */
export function shortStringToFelt(str: string): bigint {
  if (str.length > 31) {
    throw new Error(`Short string must be <= 31 chars, got ${str.length}`);
  }
  return BigInt("0x" + Buffer.from(str).toString("hex"));
}

/**
 * Check if a string is a numeric string (hex like "0x..." or decimal digits only).
 */
function isNumericString(str: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(str) || /^[0-9]+$/.test(str);
}

/**
 * Poseidon hash of multiple felts.
 * String arguments are converted as follows:
 * - Numeric strings (hex "0x..." or decimal) are converted via toBigInt
 * - Short ASCII strings (domain tags like "channel_key:v1") are converted as Cairo short strings
 *
 * Note: This matches Cairo's hash function which does:
 *   PoseidonTrait::new().update_with(poseidon_hash_span(data)).finalize()
 * This is effectively h(h(data)) - a double hash.
 */
export function hash(...values: (BigNumberish | string)[]): Hash {
  const feltValues = values.map((v) => {
    if (typeof v === "string") {
      // Numeric strings should be converted to bigint, not as short strings
      return isNumericString(v) ? toBigInt(v) : shortStringToFelt(v);
    }
    return toBigInt(v);
  });

  // Match Cairo's hash function: h(h(data))
  // First hash the array, then hash the result
  const firstHash = ec.starkCurve.poseidonHashMany(feltValues);
  return ec.starkCurve.poseidonHashMany([firstHash]);
}

// ============ Channel Info Encryption ============

const starkCurve = ec.starkCurve;

// Domain separation tags (must match Cairo constants)
const ENC_CHANNEL_KEY_TAG = BigInt(
  "0x" + Buffer.from("channel_info:enc_channel_key:v1").toString("hex")
);
const ENC_SENDER_ADDR_TAG = BigInt(
  "0x" + Buffer.from("channel_info:enc_sender_addr:v1").toString("hex")
);

/**
 * Encrypted channel information structure.
 * Matches the Cairo EncChannelInfo struct.
 */
export type EncChannelInfo = {
  /** Ephemeral ECDH public key x-coordinate (rG.x) */
  ephemeralPubkey: bigint;
  /** Encrypted channel key: h(ENC_CHANNEL_KEY_TAG, shared_x) + channel_key */
  encChannelKey: bigint;
  /** Encrypted sender address: h(ENC_SENDER_ADDR_TAG, shared_x) + sender_addr */
  encSenderAddr: bigint;
};

/**
 * Decrypted channel information.
 */
export type ChannelInfo = {
  key: ChannelKey;
  sender: StarknetAddress;
};

/**
 * Compute the hash used to encrypt the channel key.
 */
function computeEncChannelKeyHash(sharedX: bigint): Hash {
  return hash(ENC_CHANNEL_KEY_TAG, sharedX);
}

/**
 * Compute the hash used to encrypt the sender address.
 */
function computeEncSenderAddrHash(sharedX: bigint): Hash {
  return hash(ENC_SENDER_ADDR_TAG, sharedX);
}

/**
 * Convert BigNumberish to bytes for starkCurve operations.
 */
function toBytes32(value: BigNumberish): Uint8Array {
  const bi = toBigInt(value);
  const hex = bi.toString(16).padStart(64, "0");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/**
 * Get the x-coordinate from a public key bytes (compressed or uncompressed).
 */
function getXCoordinateFromBytes(publicKeyBytes: Uint8Array): bigint {
  // If 33 bytes (compressed), skip the prefix byte
  // If 65 bytes (uncompressed), skip prefix and take first 32 bytes
  const start = publicKeyBytes.length === 33 ? 1 : publicKeyBytes.length === 65 ? 1 : 0;
  const end = start + 32;
  return BigInt("0x" + Buffer.from(publicKeyBytes.slice(start, end)).toString("hex"));
}

/**
 * Recover a curve point from just the x-coordinate.
 * Computes y from the curve equation: y² = x³ + ax + b (mod p)
 *
 * @param x - The x-coordinate as bigint
 * @returns The point as compressed public key bytes, or throws if x is not on curve
 */
function recoverPointFromX(x: bigint): Uint8Array {
  const Fp = starkCurve.CURVE.Fp;
  const a = starkCurve.CURVE.a;
  const b = starkCurve.CURVE.b;

  // y² = x³ + ax + b (mod p)
  const x3 = Fp.mul(Fp.mul(x, x), x); // x³
  const ax = Fp.mul(a, x); // ax
  const y2 = Fp.add(Fp.add(x3, ax), b); // x³ + ax + b

  // Compute y = sqrt(y²)
  const y = Fp.sqrt(y2);
  if (y === undefined) {
    throw new Error(`x-coordinate ${x} is not on the curve`);
  }

  // Create the point and return as compressed bytes
  const point = starkCurve.ProjectivePoint.fromAffine({ x, y });
  return point.toRawBytes(true); // compressed format
}

/**
 * Encrypt channel info using ECDH.
 *
 * @param recipientPublicKey - The recipient's public key (x-coordinate as bigint or full key)
 * @param channelKey - The channel key to encrypt
 * @param senderAddr - The sender's address to encrypt
 * @returns Encrypted channel info
 */
export function encryptChannelInfo(
  recipientPublicKey: PublicKey,
  channelKey: Hash,
  senderAddr: StarknetAddress
): EncChannelInfo {
  // Generate ephemeral key pair
  const ephemeralSecret = new Uint8Array([2]); // until there's forward tracing. then starkCurve.utils.randomPrivateKey();
  const ephemeralPubPoint = starkCurve.getPublicKey(ephemeralSecret);
  const ephemeralPubkey = getXCoordinateFromBytes(ephemeralPubPoint);

  // Recover recipient public key point from x-coordinate
  const recipientPubBytes = recoverPointFromX(toBigInt(recipientPublicKey));

  // Compute shared secret via ECDH
  const sharedPoint = starkCurve.getSharedSecret(ephemeralSecret, recipientPubBytes);
  const sharedX = getXCoordinateFromBytes(sharedPoint);

  // Encrypt using additive masking
  const n = starkCurve.CURVE.n;
  const encChannelKey = (computeEncChannelKeyHash(sharedX) + channelKey) % n;
  const encSenderAddr = (computeEncSenderAddrHash(sharedX) + toBigInt(senderAddr)) % n;

  return { ephemeralPubkey, encChannelKey, encSenderAddr };
}

/**
 * Decrypt channel info using ECDH.
 *
 * @param encryptedInfo - The encrypted channel info
 * @param recipientPrivateKey - The recipient's private key
 * @returns Decrypted channel key and sender address
 */
export function decryptChannelInfo(
  encryptedInfo: EncChannelInfo,
  recipientPrivateKey: PrivateKey
): ChannelInfo {
  // Recover ephemeral public key point from x-coordinate
  const ephemeralPubBytes = recoverPointFromX(encryptedInfo.ephemeralPubkey);

  // Convert private key to bytes
  const privateKeyBytes = toBytes32(recipientPrivateKey);

  // Compute shared secret
  const sharedPoint = starkCurve.getSharedSecret(privateKeyBytes, ephemeralPubBytes);
  const sharedX = getXCoordinateFromBytes(sharedPoint);

  // Decrypt using subtractive unmasking
  const n = starkCurve.CURVE.n;
  const channelKey =
    (((encryptedInfo.encChannelKey - computeEncChannelKeyHash(sharedX)) % n) + n) % n;
  const senderAddr =
    (((encryptedInfo.encSenderAddr - computeEncSenderAddrHash(sharedX)) % n) + n) % n;

  return { key: channelKey, sender: senderAddr };
}

/**
 * Derive public key from private key (returns x-coordinate).
 */
export function derivePublicKey(privateKey: PrivateKey): bigint {
  const privateKeyBytes = toBytes32(privateKey);
  const publicKeyBytes = starkCurve.getPublicKey(privateKeyBytes);
  return getXCoordinateFromBytes(publicKeyBytes);
}

// ============ Symmetric Encryption ============
/** Generate a random bigint for use in encryption */
export function generateRandom(): bigint {
  // Generate a 252-bit random value (valid felt252)
  return encode.uint8ArrayToBigInt(starkCurve.utils.randomPrivateKey());
}

/** Generate a 120-bit random value for note encryption */
export function generateRandom120(): bigint {
  const bytes = new Uint8Array(15); // 15 bytes = 120 bits
  crypto.getRandomValues(bytes);
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

export type SymmetricEncryption = {
  r: bigint;
  enc: bigint;
};

export function encryptSymmetric(
  shared: bigint,
  data: BigNumberish,
  r: bigint
): SymmetricEncryption {
  // make sure r is  a felt252
  if (r < 0n || r >= starkCurve.CURVE.n) {
    throw new Error(`r must be a felt252, got ${r}`);
  }
  return {
    r,
    enc: (hash(shared, r) + toBigInt(data)) % starkCurve.CURVE.n,
  };
}

export function decryptSymmetric(encryption: SymmetricEncryption, shared: bigint): bigint {
  return encryption.enc - (hash(shared, encryption.r) % starkCurve.CURVE.n);
}

// ============ Conversion Utilities ============

export function toBigInt(value: BigNumberish): bigint {
  return num.toBigInt(value);
}
