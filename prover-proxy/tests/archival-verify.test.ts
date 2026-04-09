// tests/archival-verify.test.ts
import { describe, it, expect } from "vitest";
import { buildKeyMap, verifyFile } from "../scripts/archival-verify.js";
import { deriveKeyPair, encryptForArchival } from "../src/archival-crypto.js";
import { formatArchivalFile } from "../src/archival-storage.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("buildKeyMap", () => {
  it("builds public key -> secret key map from viewing keys", () => {
    const viewingKeys = ["0xdeadbeef", "0xcafebabe"];
    const keyMap = buildKeyMap(viewingKeys);
    expect(keyMap.size).toBe(2);

    // Verify deterministic: same viewing key -> same public key
    const pair = deriveKeyPair("0xdeadbeef");
    expect(keyMap.has(bytesToHex(pair.publicKey))).toBe(true);
  });
});

describe("verifyFile", () => {
  it("decrypts and verifies valid JSON for viewingkey type", () => {
    const viewingKey = "0xdeadbeef";
    const pair = deriveKeyPair(viewingKey);
    const publicKeyHex = bytesToHex(pair.publicKey);
    const plaintext = '{"jsonrpc":"2.0"}';
    const encrypted = encryptForArchival(
      new TextEncoder().encode(plaintext),
      pair.publicKey
    );
    const file = formatArchivalFile("viewingkey", publicKeyHex, encrypted);

    const keyMap = buildKeyMap([viewingKey]);
    const result = verifyFile(Buffer.from(file), keyMap);
    expect(result.status).toBe("ok");
  });

  it("skips sender type files", () => {
    const file = formatArchivalFile(
      "sender",
      "aa".repeat(32),
      new Uint8Array([1])
    );
    const result = verifyFile(Buffer.from(file), new Map());
    expect(result.status).toBe("skipped_sender");
  });

  it("reports no matching key", () => {
    const pair = deriveKeyPair("0xunknown");
    const publicKeyHex = bytesToHex(pair.publicKey);
    const encrypted = encryptForArchival(
      new TextEncoder().encode("{}"),
      pair.publicKey
    );
    const file = formatArchivalFile("viewingkey", publicKeyHex, encrypted);

    const keyMap = buildKeyMap(["0xother"]);
    const result = verifyFile(Buffer.from(file), keyMap);
    expect(result.status).toBe("skipped_no_key");
  });

  it("reports decrypt failure for corrupted ciphertext", () => {
    const viewingKey = "0xdeadbeef";
    const pair = deriveKeyPair(viewingKey);
    const publicKeyHex = bytesToHex(pair.publicKey);
    // Corrupted ciphertext — enough bytes to look like a sealed box but wrong
    const corruptedCiphertext = new Uint8Array(80);
    corruptedCiphertext.fill(0xff);
    const file = formatArchivalFile(
      "viewingkey",
      publicKeyHex,
      corruptedCiphertext
    );

    const keyMap = buildKeyMap([viewingKey]);
    const result = verifyFile(Buffer.from(file), keyMap);
    expect(result.status).toBe("decrypt_failed");
  });
});
