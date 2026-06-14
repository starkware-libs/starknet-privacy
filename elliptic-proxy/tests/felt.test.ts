// tests/felt.test.ts
import { describe, it, expect } from "vitest";
import { feltListIncludes, isHexFelt } from "../src/felt.js";

// Stark field prime: 2^251 + 17*2^192 + 1.
const STARK_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;

describe("isHexFelt", () => {
  it("accepts a small hex felt", () => {
    expect(isHexFelt("0xabc123")).toBe(true);
  });

  it("accepts mixed-case hex digits", () => {
    expect(isHexFelt("0xAbCdEf")).toBe(true);
  });

  it("accepts the largest felt (prime - 1)", () => {
    expect(isHexFelt("0x" + (STARK_PRIME - 1n).toString(16))).toBe(true);
  });

  it("rejects the Stark prime itself", () => {
    expect(isHexFelt("0x" + STARK_PRIME.toString(16))).toBe(false);
  });

  it("accepts a zero-padded 64-digit address", () => {
    expect(
      isHexFelt(
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      )
    ).toBe(true);
  });

  it("rejects 65 hex digits", () => {
    expect(isHexFelt("0x0" + "f".repeat(64))).toBe(false);
  });

  it("rejects a 64-digit value above the prime", () => {
    expect(isHexFelt("0x" + "f".repeat(64))).toBe(false); // 2^256 - 1
  });

  it("rejects a 63-digit value above the prime", () => {
    expect(isHexFelt("0x" + "f".repeat(63))).toBe(false); // 2^252 - 1
  });

  it("rejects a missing 0x prefix", () => {
    expect(isHexFelt("abc123")).toBe(false);
  });

  it("rejects an empty hex part", () => {
    expect(isHexFelt("0x")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isHexFelt("0xghij")).toBe(false);
  });

  it("rejects an adversarially long string cheaply", () => {
    expect(isHexFelt("0x" + "f".repeat(1_000_000))).toBe(false);
  });
});

describe("feltListIncludes", () => {
  it("returns false for an undefined list", () => {
    expect(feltListIncludes(undefined, 0xabcn)).toBe(false);
  });

  it("returns false for an empty list", () => {
    expect(feltListIncludes([], 0xabcn)).toBe(false);
  });

  it("matches an exact entry", () => {
    expect(feltListIncludes(["0xabc"], 0xabcn)).toBe(true);
  });

  it("matches a zero-padded entry against the stripped felt", () => {
    expect(feltListIncludes(["0x00deadbeef"], 0xdeadbeefn)).toBe(true);
  });

  it("does not match a different felt", () => {
    expect(feltListIncludes(["0xabc"], 0xdefn)).toBe(false);
  });
});
