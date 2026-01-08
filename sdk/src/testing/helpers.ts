/**
 * Shared helpers for testing utilities.
 */

import type { CallAndProof, Proof } from "../interfaces.js";

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
