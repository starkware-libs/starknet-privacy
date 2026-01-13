/**
 * Shared helpers for testing utilities.
 */

import type { CallAndProof, ExecuteResult, Proof } from "../interfaces.js";
import { StateCallback } from "./pool.js";

// ============ Mock Helpers ============

export function createMockProof(overrides?: Partial<Proof>): Proof {
  return {
    data: new Uint8Array([0, 1, 2, 3]),
    outputHash: 0n,
    output: [0n],
    ...overrides,
  };
}

export function createMockCallAndProof(callbacks?: StateCallback[]): CallAndProof {
  return {
    call: {
      contractAddress: "0x0",
      entrypoint: "execute_writes",
      calldata: [],
      ...(typeof callbacks !== "undefined" ? { call: () => callbacks.map((cb) => cb()) } : {}),
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    proof: createMockProof(),
  };
}

// Symbol used as a type marker for withdrawal operations (vs NoteNonce for transfers)
export const Withdrawal = Symbol("Withdrawal");

// ============ Test Helpers ============

/**
 * Helper to apply state changes by calling callAndProof.call.call() if it exists.
 * This executes the callbacks returned from PrivacyPool.execute() to actually
 * apply the state changes to the pool.
 */
export function applyStateChanges(result: ExecuteResult): ExecuteResult {
  const { callAndProof } = result;
  if (
    callAndProof.call &&
    typeof callAndProof.call === "object" &&
    "call" in callAndProof.call &&
    typeof callAndProof.call.call === "function"
  ) {
    callAndProof.call.call();
  }
  return result;
}
