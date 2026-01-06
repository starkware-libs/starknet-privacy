/**
 * Shared helpers for testing utilities.
 */

import type { CallAndProof, Proof, StarknetAddress } from "../interfaces.js";
import { Witness } from "../interfaces.js";
import type { Hash, PrivateKey, PublicKey } from "../utils/crypto.js";
import { hash } from "../utils/crypto.js";
import type { NoteNonce } from "../internal/index.js";

// ============ Mock Helpers ============

export function createMockProof(overrides?: Partial<Proof>): Proof {
  return {
    data: new Uint8Array([0, 1, 2, 3]),
    outputHash: 0n,
    output: [0n],
    ...overrides,
  };
}

export function createMockCallAndProof(overrides?: Partial<CallAndProof>): CallAndProof {
  return {
    call: {
      contractAddress: "0x0",
      entrypoint: "mock_entrypoint",
      calldata: [],
    },
    proof: createMockProof(),
    ...overrides,
  };
}

// Symbol used as a type marker for withdrawal operations (vs NoteNonce for transfers)
export const Withdrawal = Symbol("Withdrawal");

// ============ Hash Helpers ============

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
  tokenKey: (channelKey: Hash, nonce: NoteNonce): Hash =>
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
