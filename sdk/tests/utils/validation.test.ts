import { describe, it, expect } from "vitest";
import { assertViewingKey } from "../../src/utils/validation.js";
import { MAX_VIEWING_KEY } from "../../src/interfaces.js";

// The pool contract accepts a viewing key k only if 1 <= k < HALF_ORDER
// (`privacy::utils::is_canonical_key`), and MAX_VIEWING_KEY equals HALF_ORDER.
describe("assertViewingKey", () => {
  it("accepts the smallest and largest keys the contract accepts", () => {
    expect(() => assertViewingKey(1n)).not.toThrow();
    expect(() => assertViewingKey(MAX_VIEWING_KEY - 1n)).not.toThrow();
  });

  it("rejects zero", () => {
    expect(() => assertViewingKey(0n)).toThrow();
  });

  it("rejects MAX_VIEWING_KEY, which the contract treats as non-canonical", () => {
    expect(() => assertViewingKey(MAX_VIEWING_KEY)).toThrow();
    expect(() => assertViewingKey(MAX_VIEWING_KEY + 1n)).toThrow();
  });
});
