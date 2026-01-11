/**
 * Hash utility functions for privacy operations.
 * Names and formulas match the Cairo implementation in packages/privacy/src/hashes.cairo
 */

import type { StarknetAddress } from "../interfaces.js";
import { Witness } from "../interfaces.js";
import type { TokenNonce } from "../internal/index.js";
import { hash, type Hash, type PrivateKey, type PublicKey } from "./crypto.js";

// Domain separation tags (must match Cairo constants in domain_separation module)
const CHANNEL_KEY_TAG = "channel_key:v1";
const CHANNEL_ID_TAG = "channel_id:v1";
const SUBCHANNEL_KEY_TAG = "subchannel_key:v1";
const SUBCHANNEL_ID_TAG = "subchannel_id:v1";
const NOTE_ID_TAG = "enc_note:id:v1";
const NULLIFIER_TAG = "nullifier:v1";

export const hashes = {
  /**
   * Computes the channel key.
   * `channel_key = h(CHANNEL_KEY_TAG, sender_addr, sender_private_key, recipient_addr, recipient_public_key)`
   */
  channelKey: (
    senderAddr: StarknetAddress,
    senderPrivateKey: PrivateKey,
    recipientAddr: StarknetAddress,
    recipientPublicKey: PublicKey
  ): Hash => hash(CHANNEL_KEY_TAG, senderAddr, senderPrivateKey, recipientAddr, recipientPublicKey),

  /**
   * Computes the channel id given the channel key.
   * `channel_id = h(CHANNEL_ID_TAG, channel_key, sender_addr, recipient_addr, recipient_public_key)`
   */
  channelId: (
    channelKey: Hash,
    senderAddr: StarknetAddress,
    recipientAddr: StarknetAddress,
    recipientPublicKey: PublicKey
  ): Hash => hash(CHANNEL_ID_TAG, channelKey, senderAddr, recipientAddr, recipientPublicKey),

  /**
   * Computes the subchannel key given the channel key and index.
   * `subchannel_key = h(SUBCHANNEL_KEY_TAG, channel_key, slot, sequence)`
   * Cairo uses (index, 0) where index=slot, 0=sequence
   */
  subchannelKey: (channelKey: Hash, nonce: TokenNonce): Hash =>
    hash(SUBCHANNEL_KEY_TAG, channelKey, nonce.slot, nonce.sequence),

  /**
   * Computes the subchannel id given the channel key and token.
   * `subchannel_id = h(SUBCHANNEL_ID_TAG, channel_key, recipient_addr, recipient_public_key, token)`
   */
  subchannelId: (
    channelKey: Hash,
    recipientAddr: StarknetAddress,
    recipientPublicKey: PublicKey,
    token: StarknetAddress
  ): Hash => hash(SUBCHANNEL_ID_TAG, channelKey, recipientAddr, recipientPublicKey, token),

  /**
   * Computes the note id.
   * `note_id = h(NOTE_ID_TAG, channel_key, token, slot, sequence)`
   * Cairo uses (index, 0) where index=slot, 0=sequence
   */
  noteId: (witness: Witness, token: StarknetAddress): Hash =>
    hash(NOTE_ID_TAG, witness.channelKey, token, witness.nonce.slot, witness.nonce.sequence),

  /**
   * Computes the nullifier.
   * `nullifier = h(NULLIFIER_TAG, channel_key, token, slot, sequence, owner_private_key)`
   * Cairo uses (index, 0, privKey) where index=slot, 0=sequence
   */
  nullifier: (witness: Witness, token: StarknetAddress, ownerPrivateKey: PrivateKey): Hash =>
    hash(
      NULLIFIER_TAG,
      witness.channelKey,
      token,
      witness.nonce.slot,
      witness.nonce.sequence,
      ownerPrivateKey
    ),
};
