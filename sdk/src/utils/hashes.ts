/**
 * Hash utility functions for privacy operations.
 */

import type { StarknetAddress } from "../interfaces.js";
import { Witness } from "../interfaces.js";
import type { TokenNonce } from "../internal/index.js";
import { hash, type Hash, type PrivateKey, type PublicKey } from "./crypto.js";

export const hashes = {
  channelKey: (
    from: StarknetAddress,
    fromPrivateKey: PrivateKey,
    to: StarknetAddress,
    toPublicKey: PublicKey
  ): Hash => hash(from, fromPrivateKey, to, toPublicKey),

  channelExists: (
    channelKey: Hash,
    from: StarknetAddress,
    to: StarknetAddress,
    toPublicKey: PublicKey
  ): Hash => hash(channelKey, from, to, toPublicKey),

  tokenKey: (channelKey: Hash, nonce: TokenNonce): Hash =>
    hash(channelKey, nonce.slot, nonce.sequence),

  tokenExists: (
    channelKey: Hash,
    to: StarknetAddress,
    toPublicKey: PublicKey,
    token: StarknetAddress
  ): Hash => hash(channelKey, to, toPublicKey, token),

  noteId: (witness: Witness, token: StarknetAddress): Hash =>
    hash(witness.channelKey, token, witness.nonce.slot, witness.nonce.sequence),

  nullifier: (witness: Witness, token: StarknetAddress, ownerPrivateKey: PrivateKey): Hash =>
    hash(witness.channelKey, token, witness.nonce.slot, witness.nonce.sequence, ownerPrivateKey),
};
