import { gcm } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha384 } from "@noble/hashes/sha2.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCrypto = globalThis.crypto;

describe("installOhttpWebCryptoFallback", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
    vi.resetModules();
  });

  it("can be retried when crypto.subtle becomes available later", async () => {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });
    const { installOhttpWebCryptoFallback } =
      await import("../../src/internal/ohttp-webcrypto-fallback.js");

    installOhttpWebCryptoFallback();

    const subtle = createThrowingSubtle();
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { subtle },
    });

    installOhttpWebCryptoFallback();

    const keyData = new Uint8Array([1, 2, 3, 4]);
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-384" },
      false,
      ["sign"]
    );
    const data = new Uint8Array([5, 6, 7, 8]);
    const signature = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, data));

    expect(signature).toEqual(hmac(sha384, keyData, data));
  });

  it("falls back for AES-GCM encrypt and decrypt", async () => {
    const subtle = createThrowingSubtle();
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { subtle },
    });
    const { installOhttpWebCryptoFallback } =
      await import("../../src/internal/ohttp-webcrypto-fallback.js");

    installOhttpWebCryptoFallback();

    const keyData = new Uint8Array(16).fill(7);
    const iv = new Uint8Array(12).fill(3);
    const aad = new Uint8Array([1, 2, 3]);
    const plaintext = new Uint8Array([4, 5, 6]);
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );

    const ciphertext = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        key,
        plaintext
      )
    );
    expect(ciphertext).toEqual(gcm(keyData, iv, aad).encrypt(plaintext));

    const decrypted = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        key,
        ciphertext
      )
    );
    expect(decrypted).toEqual(plaintext);
  });
});

function createThrowingSubtle(): SubtleCrypto {
  return {
    importKey: vi.fn().mockRejectedValue(new Error("native importKey unavailable")),
    sign: vi.fn().mockRejectedValue(new Error("native sign unavailable")),
    encrypt: vi.fn().mockRejectedValue(new Error("native encrypt unavailable")),
    decrypt: vi.fn().mockRejectedValue(new Error("native decrypt unavailable")),
  } as unknown as SubtleCrypto;
}
