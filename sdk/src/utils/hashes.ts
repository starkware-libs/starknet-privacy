/**
 * Hash utility functions for privacy operations.
 * AUTO-GENERATED from packages/privacy/src/hashes.cairo
 * To regenerate: npx tsx scripts/generate-hashes.ts
 */

import type { BigNumberish } from "starknet";
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
const ENC_RECIPIENT_ADDR_TAG = "ENC_RECIPIENT_ADDR_TAG:V1";
const OUTGOING_CHANNEL_KEY_TAG = "OUTGOING_CHANNEL_KEY_TAG:V1";

/** See packages/privacy/src/hashes.cairo for documentation. */
export function compute_enc_private_key_hash(shared_x: bigint): bigint {
  return hash(ENC_PRIVATE_KEY_TAG, shared_x);
}

/** See packages/privacy/src/hashes.cairo for documentation. */
export function compute_enc_address_hash(shared_x: bigint): bigint {
  return hash(ENC_USER_ADDR_TAG, shared_x);
}

/** See packages/privacy/src/hashes.cairo for documentation. */
export function compute_enc_token_hash(channel_key: bigint, index: number, salt: bigint): bigint {
  return hash(ENC_TOKEN_TAG, channel_key, index, 0n, salt);
}

/** See packages/privacy/src/hashes.cairo for documentation. */
export function compute_enc_channel_key_hash(shared_x: bigint): bigint {
  return hash(ENC_CHANNEL_KEY_TAG, shared_x);
}

/** See packages/privacy/src/hashes.cairo for documentation. */
export function compute_enc_sender_addr_hash(shared_x: bigint): bigint {
  return hash(ENC_SENDER_ADDR_TAG, shared_x);
}

/** See packages/privacy/src/hashes.cairo for documentation. */
export function compute_enc_recipient_addr_hash(
  sender_addr: bigint,
  sender_private_key: bigint,
  index: number,
  salt: bigint
): bigint {
  return hash(ENC_RECIPIENT_ADDR_TAG, sender_addr, sender_private_key, index, salt);
}

/** See packages/privacy/src/hashes.cairo for documentation. */
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

/** See packages/privacy/src/hashes.cairo for documentation. */
export function compute_outgoing_channel_key(
  sender_addr: bigint,
  sender_private_key: bigint,
  index: number
): bigint {
  return hash(OUTGOING_CHANNEL_KEY_TAG, sender_addr, sender_private_key, index);
}

/** See packages/privacy/src/hashes.cairo for documentation. */
export function compute_channel_id(
  channel_key: bigint,
  sender_addr: bigint,
  recipient_addr: bigint,
  recipient_public_key: bigint
): bigint {
  return hash(CHANNEL_ID_TAG, channel_key, sender_addr, recipient_addr, recipient_public_key);
}

/** See packages/privacy/src/hashes.cairo for documentation. */
export function compute_subchannel_key(channel_key: bigint, index: number): bigint {
  return hash(SUBCHANNEL_KEY_TAG, channel_key, index, 0n);
}

/** See packages/privacy/src/hashes.cairo for documentation. */
export function compute_subchannel_id(
  channel_key: bigint,
  recipient_addr: bigint,
  recipient_public_key: bigint,
  token: bigint
): bigint {
  return hash(SUBCHANNEL_ID_TAG, channel_key, recipient_addr, recipient_public_key, token);
}

/** See packages/privacy/src/hashes.cairo for documentation. */
export function compute_note_id(channel_key: bigint, token: bigint, index: number): bigint {
  return hash(NOTE_ID_TAG, channel_key, token, index, 0n);
}

/** See packages/privacy/src/hashes.cairo for documentation. */
export function compute_enc_amount_hash(
  channel_key: bigint,
  token: bigint,
  index: number,
  salt: bigint
): bigint {
  return hash(ENC_AMOUNT_TAG, channel_key, token, index, 0n, salt);
}

/** See packages/privacy/src/hashes.cairo for documentation. */
export function compute_nullifier(
  channel_key: bigint,
  token: bigint,
  index: number,
  owner_private_key: bigint
): bigint {
  return hash(NULLIFIER_TAG, channel_key, token, index, 0n, owner_private_key);
}

/**
 * @deprecated Use the individual compute_* functions instead.
 * This object is kept for backwards compatibility.
 */
export const hashes = {
  /** @deprecated Use compute_channel_key instead */
  channelKey: (
    sender_addr: BigNumberish,
    sender_private_key: BigNumberish,
    recipient_addr: BigNumberish,
    recipient_public_key: BigNumberish
  ): bigint =>
    hash(CHANNEL_KEY_TAG, sender_addr, sender_private_key, recipient_addr, recipient_public_key),
  /** @deprecated Use compute_channel_id instead */
  channelId: (
    channel_key: BigNumberish,
    sender_addr: BigNumberish,
    recipient_addr: BigNumberish,
    recipient_public_key: BigNumberish
  ): bigint => hash(CHANNEL_ID_TAG, channel_key, sender_addr, recipient_addr, recipient_public_key),
  /** @deprecated Use compute_subchannel_key instead */
  subchannelKey: (channel_key: BigNumberish, index: number): bigint =>
    hash(SUBCHANNEL_KEY_TAG, channel_key, index, 0n),
  /** @deprecated Use compute_subchannel_id instead */
  subchannelId: (
    channel_key: BigNumberish,
    recipient_addr: BigNumberish,
    recipient_public_key: BigNumberish,
    token: BigNumberish
  ): bigint => hash(SUBCHANNEL_ID_TAG, channel_key, recipient_addr, recipient_public_key, token),
  /** @deprecated Use compute_note_id instead */
  noteId: (channel_key: BigNumberish, token: BigNumberish, index: number): bigint =>
    hash(NOTE_ID_TAG, channel_key, token, index, 0n),
  /** @deprecated Use compute_nullifier instead */
  nullifier: (
    channel_key: BigNumberish,
    token: BigNumberish,
    index: number,
    owner_private_key: BigNumberish
  ): bigint => hash(NULLIFIER_TAG, channel_key, token, index, 0n, owner_private_key),
};
