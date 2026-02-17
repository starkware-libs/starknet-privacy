/**
 * Shared helpers for testing utilities.
 */

import type { CallAndProof, Proof } from "../interfaces.js";

// ============ Mock Helpers ============

export function createMockProof(overrides?: Partial<Proof>): Proof {
  return {
    data: "",
    output: ["0x0"],
    proofFacts: [],
    ...overrides,
  };
}

export function createMockCallAndProof(actions?: string[]): CallAndProof {
  return {
    call: {
      contractAddress: "0x0",
      entrypoint: "execute_writes",
      calldata: actions,
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    proof: createMockProof(),
  };
}

// Symbol used as a type marker for withdrawal operations (vs NoteNonce for transfers)
export const Withdrawal = Symbol("Withdrawal");
