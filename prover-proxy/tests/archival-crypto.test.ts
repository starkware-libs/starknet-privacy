// tests/archival-crypto.test.ts
import { describe, it, expect } from "vitest";
import {
  deriveKeyPair,
  extractEncryptionSeed,
  encryptForArchival,
  decryptArchival,
} from "../src/archival-crypto.js";

describe("extractEncryptionSeed", () => {
  it("extracts viewing key from privacy pool calldata", () => {
    // Privacy pool calldata layout:
    // [0]=call_count "0x1", [1]=contract, [2]=selector, [3]=inner_len,
    // [4]=user_addr, [5]=viewing_key, [6..]=actions
    const calldata = [
      "0x1",
      "0xpool",
      "0xsel",
      "0x3",
      "0xuser",
      "0xdeadbeef",
      "0x0",
    ];
    const result = extractEncryptionSeed(calldata);
    expect(result.type).toBe("viewingkey");
    expect(result.seed).toBe("0xdeadbeef");
  });

  it("falls back to sender address for non-privacy-pool calldata", () => {
    // Multi-call or short calldata — not a privacy pool tx
    const calldata = ["0x2", "0xaddr"];
    const result = extractEncryptionSeed(calldata, "0xsender");
    expect(result.type).toBe("sender");
    expect(result.seed).toBe("0xsender");
  });

  it("falls back to sender address when inner calldata is too short", () => {
    const calldata = ["0x1", "0xpool", "0xsel", "0x1", "0xonly"];
    const result = extractEncryptionSeed(calldata, "0xsender");
    expect(result.type).toBe("sender");
    expect(result.seed).toBe("0xsender");
  });
});

describe("deriveKeyPair", () => {
  it("derives deterministic X25519 key pair from seed", () => {
    const pair1 = deriveKeyPair("0xdeadbeef");
    const pair2 = deriveKeyPair("0xdeadbeef");
    expect(pair1.publicKey).toEqual(pair2.publicKey);
    expect(pair1.secretKey).toEqual(pair2.secretKey);
    expect(pair1.publicKey.length).toBe(32);
    expect(pair1.secretKey.length).toBe(32);
  });

  it("derives different keys for different seeds", () => {
    const pair1 = deriveKeyPair("0xaaa");
    const pair2 = deriveKeyPair("0xbbb");
    expect(pair1.publicKey).not.toEqual(pair2.publicKey);
  });
});

describe("encrypt and decrypt round-trip", () => {
  it("encrypts with public key and decrypts with secret key", () => {
    const pair = deriveKeyPair("0xdeadbeef");
    const plaintext = Buffer.from(
      JSON.stringify({ type: "INVOKE", version: "0x3" })
    );
    const encrypted = encryptForArchival(plaintext, pair.publicKey);
    expect(encrypted.length).toBeGreaterThan(plaintext.length);

    const decrypted = decryptArchival(
      encrypted,
      pair.publicKey,
      pair.secretKey
    );
    expect(decrypted).not.toBeNull();
    expect(Buffer.from(decrypted!).toString()).toBe(plaintext.toString());
  });

  it("fails to decrypt with wrong key", () => {
    const pair1 = deriveKeyPair("0xaaa");
    const pair2 = deriveKeyPair("0xbbb");
    const encrypted = encryptForArchival(
      Buffer.from("secret"),
      pair1.publicKey
    );
    const decrypted = decryptArchival(
      encrypted,
      pair1.publicKey,
      pair2.secretKey
    );
    expect(decrypted).toBeNull();
  });
});
