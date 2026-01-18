/**
 * Hash utility functions for privacy operations.
 * AUTO-GENERATED from packages/privacy/src/hashes.cairo
 * To regenerate: npx tsx scripts/generate-hashes.ts
 */

import { hash } from "./crypto.js";

// Domain separation tags (from Cairo domain_separation module)
const CHANNEL_ID_TAG = "CHANNEL_ID_TAG:V1";
const CHANNEL_KEY_TAG = "CHANNEL_KEY_TAG:V1";
const SUBCHANNEL_ID_TAG = "SUBCHANNEL_ID_TAG:V1";
const SUBCHANNEL_KEY_TAG = "SUBCHANNEL_KEY_TAG:V1";
const NULLIFIER_TAG = "NULLIFIER_TAG:V1";
const ENC_CHANNEL_KEY_TAG = "ENC_CHANNEL_KEY_TAG:V1";
const ENC_SENDER_ADDR_TAG = "ENC_SENDER_ADDR_TAG:V1";
const NOTE_ID_TAG = "NOTE_ID_TAG:V1";
const ENC_AMOUNT_TAG = "ENC_AMOUNT_TAG:V1";
const ENC_TOKEN_TAG = "ENC_TOKEN_TAG:V1";
const ENC_PRIVATE_KEY_TAG = "ENC_PRIVATE_KEY_TAG:V1";
const ENC_USER_ADDR_TAG = "ENC_USER_ADDR_TAG:V1";

/**
 * Returns `h(ENC_PRIVATE_KEY_TAG, shared_x)`
 */
export function compute_enc_private_key_hash(shared_x: bigint): bigint {
  return hash(ENC_PRIVATE_KEY_TAG, shared_x);
}

/**
 * Returns `h(ENC_ADDRESS_TAG, shared_x)`
 */
export function compute_enc_address_hash(shared_x: bigint): bigint {
  return hash(ENC_USER_ADDR_TAG, shared_x);
}

/**
 * Returns `h(ENC_TOKEN_TAG, channel_key, index, 0, salt)`
 */
export function compute_enc_token_hash(channel_key: bigint, index: number, salt: bigint): bigint {
  return hash(ENC_TOKEN_TAG, channel_key, index, 0n, salt);
}

/**
 * Returns `h(ENC_CHANNEL_KEY_TAG, shared_x)`
 */
export function compute_enc_channel_key_hash(shared_x: bigint): bigint {
  return hash(ENC_CHANNEL_KEY_TAG, shared_x);
}

/**
 * Returns `h(ENC_SENDER_ADDR_TAG, shared_x)`
 */
export function compute_enc_sender_addr_hash(shared_x: bigint): bigint {
  return hash(ENC_SENDER_ADDR_TAG, shared_x);
}

/**
 * recipient_public_key)`
 */
export function compute_channel_key(
  sender_addr: bigint,
  sender_private_key: bigint,
  recipient_addr: bigint,
  recipient_public_key: bigint
): bigint {
  return hash(
    CHANNEL_KEY_TAG,
    sender_addr,
    sender_private_key,
    recipient_addr,
    recipient_public_key
  );
}

/**
 * `channel_id = h(CHANNEL_ID_TAG, channel_key, sender_addr, recipient_addr, recipient_public_key)`
 */
export function compute_channel_id(
  channel_key: bigint,
  sender_addr: bigint,
  recipient_addr: bigint,
  recipient_public_key: bigint
): bigint {
  return hash(CHANNEL_ID_TAG, channel_key, sender_addr, recipient_addr, recipient_public_key);
}

/**
 * `subchannel_key = h(SUBCHANNEL_KEY_TAG, channel_key, index, 0)`
 */
export function compute_subchannel_key(channel_key: bigint, index: number): bigint {
  return hash(SUBCHANNEL_KEY_TAG, channel_key, index, 0n);
}

/**
 * `subchannel_id = h(SUBCHANNEL_ID_TAG, channel_key, recipient_addr, recipient_public_key, token)`
 */
export function compute_subchannel_id(
  channel_key: bigint,
  recipient_addr: bigint,
  recipient_public_key: bigint,
  token: bigint
): bigint {
  return hash(SUBCHANNEL_ID_TAG, channel_key, recipient_addr, recipient_public_key, token);
}

/**
 * `note_id = h(NOTE_ID_TAG, channel_key, token, index, 0)`
 */
export function compute_note_id(channel_key: bigint, token: bigint, index: number): bigint {
  return hash(NOTE_ID_TAG, channel_key, token, index, 0n);
}

/**
 * Returns `h(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt)`.
 */
export function compute_enc_amount_hash(
  channel_key: bigint,
  token: bigint,
  index: number,
  salt: bigint
): bigint {
  return hash(ENC_AMOUNT_TAG, channel_key, token, index, 0n, salt);
}

/**
 * `nullifier = h(NULLIFIER_TAG, channel_key, token, index, 0, owner_private_key)`
 */
export function compute_nullifier(
  channel_key: bigint,
  token: bigint,
  index: number,
  owner_private_key: bigint
): bigint {
  return hash(NULLIFIER_TAG, channel_key, token, index, 0n, owner_private_key);
}
