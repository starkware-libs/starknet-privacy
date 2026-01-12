import { describe, expect, it } from "vitest";
import {
  encryptChannelInfo,
  decryptChannelInfo,
  encryptSymmetric,
  decryptSymmetric,
  derivePublicKey,
  hash,
} from "../../src/utils/crypto.js";

describe("encryption", () => {
  const ALICE_PRIVATE_KEY = 12345n;
  const BOB_PRIVATE_KEY = 67890n;

  describe("derivePublicKey", () => {
    it("derives public key from private key", () => {
      const publicKey = derivePublicKey(ALICE_PRIVATE_KEY);

      expect(typeof publicKey).toBe("bigint");
      expect(publicKey).toBeGreaterThan(0n);
    });

    it("different private keys produce different public keys", () => {
      const alicePub = derivePublicKey(ALICE_PRIVATE_KEY);
      const bobPub = derivePublicKey(BOB_PRIVATE_KEY);

      expect(alicePub).not.toBe(bobPub);
    });

    it("same private key always produces same public key", () => {
      const pub1 = derivePublicKey(ALICE_PRIVATE_KEY);
      const pub2 = derivePublicKey(ALICE_PRIVATE_KEY);

      expect(pub1).toBe(pub2);
    });
  });

  describe("encryptChannelInfo / decryptChannelInfo", () => {
    it("encrypts and decrypts channel info round-trip", () => {
      const bobPublicKey = derivePublicKey(BOB_PRIVATE_KEY);
      const channelKey = hash(42n, 123n); // Some channel key
      const senderAddr = "0xA11CE"; // Valid hex address

      const encrypted = encryptChannelInfo(bobPublicKey, channelKey, senderAddr);

      expect(encrypted.ephemeralPubkey).toBeDefined();
      expect(encrypted.encChannelKey).toBeDefined();
      expect(encrypted.encSenderAddr).toBeDefined();

      // Bob decrypts with his private key
      const decrypted = decryptChannelInfo(encrypted, BOB_PRIVATE_KEY);

      expect(decrypted.key).toBe(channelKey);
      // Sender address comes back as bigint
      expect(decrypted.sender).toBe(BigInt(senderAddr));
    });

    it("wrong private key cannot decrypt", () => {
      const bobPublicKey = derivePublicKey(BOB_PRIVATE_KEY);
      const channelKey = hash(1n, 2n, 3n);
      const senderAddr = "0x123";

      const encrypted = encryptChannelInfo(bobPublicKey, channelKey, senderAddr);

      // Alice tries to decrypt (wrong key)
      const wrongDecrypt = decryptChannelInfo(encrypted, ALICE_PRIVATE_KEY);

      // Values will be garbage, not matching original
      expect(wrongDecrypt.key).not.toBe(channelKey);
    });

    it("produces different ciphertext each time (randomized)", () => {
      const bobPublicKey = derivePublicKey(BOB_PRIVATE_KEY);
      const channelKey = hash(100n);
      const senderAddr = "0xABC";

      const enc1 = encryptChannelInfo(bobPublicKey, channelKey, senderAddr);
      const enc2 = encryptChannelInfo(bobPublicKey, channelKey, senderAddr);

      // Different ephemeral keys each time
      expect(enc1.ephemeralPubkey).not.toBe(enc2.ephemeralPubkey);
      expect(enc1.encChannelKey).not.toBe(enc2.encChannelKey);

      // But both decrypt to same value
      const dec1 = decryptChannelInfo(enc1, BOB_PRIVATE_KEY);
      const dec2 = decryptChannelInfo(enc2, BOB_PRIVATE_KEY);
      expect(dec1.key).toBe(dec2.key);
    });
  });

  describe("encryptSymmetric / decryptSymmetric", () => {
    it("encrypts and decrypts with shared secret", () => {
      const sharedSecret = hash(ALICE_PRIVATE_KEY, BOB_PRIVATE_KEY);
      const data = 42n;

      const encrypted = encryptSymmetric(sharedSecret, data);
      const decrypted = decryptSymmetric(encrypted, sharedSecret);

      expect(decrypted).toBe(data);
    });

    it("wrong shared secret cannot decrypt", () => {
      const sharedSecret = hash(1n, 2n);
      const wrongSecret = hash(3n, 4n);
      const data = 12345n;

      const encrypted = encryptSymmetric(sharedSecret, data);
      const wrongDecrypt = decryptSymmetric(encrypted, wrongSecret);

      expect(wrongDecrypt).not.toBe(data);
    });

    it("produces different ciphertext each time (randomized)", () => {
      const sharedSecret = hash(100n);
      const data = 999n;

      const enc1 = encryptSymmetric(sharedSecret, data);
      const enc2 = encryptSymmetric(sharedSecret, data);

      // Different random r each time
      expect(enc1.r).not.toBe(enc2.r);
      expect(enc1.enc).not.toBe(enc2.enc);

      // But both decrypt to same value
      expect(decryptSymmetric(enc1, sharedSecret)).toBe(data);
      expect(decryptSymmetric(enc2, sharedSecret)).toBe(data);
    });
  });

  describe("hash", () => {
    it("produces consistent results", () => {
      const h1 = hash(1n, 2n, 3n);
      const h2 = hash(1n, 2n, 3n);

      expect(h1).toBe(h2);
    });

    it("different inputs produce different hashes", () => {
      const h1 = hash(1n, 2n);
      const h2 = hash(1n, 3n);
      const h3 = hash(2n, 1n);

      expect(h1).not.toBe(h2);
      expect(h1).not.toBe(h3);
      expect(h2).not.toBe(h3);
    });

    it("accepts BigNumberish values", () => {
      const h1 = hash("0x10", 16n);
      const h2 = hash(16, "0x10");

      // Both should work (same values, different order still different hash)
      expect(typeof h1).toBe("bigint");
      expect(typeof h2).toBe("bigint");
    });
  });
});
