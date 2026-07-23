import { describe, it, expect } from "vitest";
import { ec } from "starknet";
import { deriveViewingKey, passphraseViewingKeyProvider } from "../src/index.js";

const ADDRESS = 0x123n;
const OTHER_ADDRESS = 0x456n;
const STARK_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
// The privacy pool accepts a user key only when it is below the Stark curve half-order
// (privacy::utils::is_canonical_key); the KDF must canonicalize into this range.
const HALF_ORDER = ec.starkCurve.CURVE.n >> 1n;

describe("deriveViewingKey", () => {
  it("is deterministic for the same passphrase + address", () => {
    expect(deriveViewingKey("correct horse", ADDRESS)).toBe(
      deriveViewingKey("correct horse", ADDRESS)
    );
  });

  it("is salted by the address — same passphrase, different account, different key", () => {
    expect(deriveViewingKey("correct horse", ADDRESS)).not.toBe(
      deriveViewingKey("correct horse", OTHER_ADDRESS)
    );
  });

  it("depends on the passphrase", () => {
    expect(deriveViewingKey("correct horse", ADDRESS)).not.toBe(
      deriveViewingKey("battery staple", ADDRESS)
    );
  });

  it("produces a Stark-field element", () => {
    const key = deriveViewingKey("correct horse", ADDRESS);
    expect(key).toBeGreaterThan(0n);
    expect(key).toBeLessThan(STARK_PRIME);
  });

  it("produces a canonical key (non-zero, below the half-order) for any passphrase", () => {
    // "e2e-signing-passphrase" derived a non-canonical key before canonicalization was added.
    for (const passphrase of [
      "e2e-signing-passphrase",
      "correct horse",
      "",
      "x".repeat(40),
      "another passphrase entirely",
    ]) {
      const key = deriveViewingKey(passphrase, ADDRESS);
      expect(key).toBeGreaterThan(0n);
      expect(key).toBeLessThan(HALF_ORDER);
    }
  });

  it("handles an empty passphrase without throwing", () => {
    expect(deriveViewingKey("", ADDRESS)).toBeGreaterThan(0n);
  });

  it("distinguishes passphrases longer than one felt limb (>31 bytes)", () => {
    const long = "x".repeat(40);
    expect(deriveViewingKey(long, ADDRESS)).not.toBe(deriveViewingKey(`${long}y`, ADDRESS));
  });
});

describe("passphraseViewingKeyProvider", () => {
  it("getViewingKey resolves to deriveViewingKey and is stable across calls", async () => {
    const provider = passphraseViewingKeyProvider("correct horse", ADDRESS);
    const first = await provider.getViewingKey();
    expect(first).toBe(deriveViewingKey("correct horse", ADDRESS));
    expect(await provider.getViewingKey()).toBe(first);
  });
});
