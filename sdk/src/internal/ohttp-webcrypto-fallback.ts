import { gcm } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";

/**
 * Installs a narrow React Native fallback for the WebCrypto operations that
 * ohttp-ts currently performs internally while decrypting OHTTP responses.
 *
 * The patch is deliberately conservative: native WebCrypto is always tried
 * first, and noble is used only when the runtime throws for raw HMAC/AES-GCM
 * key import. This keeps browsers and Node on their native implementations
 * while allowing React Native's partial SubtleCrypto implementation to work.
 *
 * TODO: Remove this once ohttp-ts accepts injectable HKDF/AEAD primitives.
 */
let didInstall = false;

export function installOhttpWebCryptoFallback(): void {
  if (didInstall) return;

  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.importKey !== "function") return;

  didInstall = true;
  installFallback(subtle);
}

type FallbackCryptoKey = object;

type NobleHash = Parameters<typeof hmac>[0];

type HmacFallbackKeyStore = WeakMap<FallbackCryptoKey, { keyData: Uint8Array; hash: NobleHash }>;

type AesFallbackKeyStore = WeakMap<FallbackCryptoKey, { keyData: Uint8Array }>;

function installFallback(subtle: SubtleCrypto): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const patchedSubtle = subtle as any;
  const originalImportKey = patchedSubtle.importKey.bind(patchedSubtle);
  const originalSign = patchedSubtle.sign?.bind(patchedSubtle);
  const originalEncrypt = patchedSubtle.encrypt?.bind(patchedSubtle);
  const originalDecrypt = patchedSubtle.decrypt?.bind(patchedSubtle);

  const hmacKeys: HmacFallbackKeyStore = new WeakMap();
  const aesKeys: AesFallbackKeyStore = new WeakMap();

  patchedSubtle.importKey = async function patchedImportKey(
    format: string,
    keyData: BufferSource,
    algorithm: AlgorithmIdentifier | HmacImportParams | AesKeyAlgorithm,
    extractable: boolean,
    keyUsages: KeyUsage[]
  ): Promise<CryptoKey | FallbackCryptoKey> {
    const algName = getAlgorithmName(algorithm);
    const rawKey = toUint8Array(keyData);

    const importArgs = [format, keyData, algorithm, extractable, keyUsages] as const;
    if (format === "raw" && algName === "HMAC") {
      return importHmacKeyWithFallback(originalImportKey, hmacKeys, rawKey, algorithm, importArgs);
    }
    if (format === "raw" && algName === "AES-GCM") {
      return importAesKeyWithFallback(originalImportKey, aesKeys, rawKey, importArgs);
    }
    return originalImportKey(format, keyData, algorithm, extractable, keyUsages);
  };

  patchedSubtle.sign = async function patchedSign(
    algorithm: AlgorithmIdentifier,
    key: CryptoKey | FallbackCryptoKey,
    data: BufferSource
  ): Promise<ArrayBuffer> {
    const fallbackKey = hmacKeys.get(key);
    if (fallbackKey) {
      return copyArrayBuffer(hmac(fallbackKey.hash, fallbackKey.keyData, toUint8Array(data)));
    }
    return originalSign(algorithm, key, data);
  };

  patchedSubtle.encrypt = async function patchedEncrypt(
    algorithm: AesGcmParams,
    key: CryptoKey | FallbackCryptoKey,
    data: BufferSource
  ): Promise<ArrayBuffer> {
    const fallbackKey = aesKeys.get(key);
    if (fallbackKey) {
      return copyArrayBuffer(
        openAesGcm(fallbackKey.keyData, algorithm).encrypt(toUint8Array(data))
      );
    }
    return originalEncrypt(algorithm, key, data);
  };

  patchedSubtle.decrypt = async function patchedDecrypt(
    algorithm: AesGcmParams,
    key: CryptoKey | FallbackCryptoKey,
    data: BufferSource
  ): Promise<ArrayBuffer> {
    const fallbackKey = aesKeys.get(key);
    if (fallbackKey) {
      return copyArrayBuffer(
        openAesGcm(fallbackKey.keyData, algorithm).decrypt(toUint8Array(data))
      );
    }
    return originalDecrypt(algorithm, key, data);
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

async function importHmacKeyWithFallback(
  originalImportKey: (...args: readonly unknown[]) => Promise<CryptoKey>,
  store: HmacFallbackKeyStore,
  keyData: Uint8Array,
  algorithm: AlgorithmIdentifier | HmacImportParams | AesKeyAlgorithm,
  args: readonly unknown[]
): Promise<CryptoKey | FallbackCryptoKey> {
  try {
    return await originalImportKey(...args);
  } catch (error) {
    const hash = getHmacHash(algorithm);
    if (!hash) throw error;
    const fallbackKey: FallbackCryptoKey = {};
    store.set(fallbackKey, { keyData, hash });
    return fallbackKey;
  }
}

async function importAesKeyWithFallback(
  originalImportKey: (...args: readonly unknown[]) => Promise<CryptoKey>,
  store: AesFallbackKeyStore,
  keyData: Uint8Array,
  args: readonly unknown[]
): Promise<CryptoKey | FallbackCryptoKey> {
  try {
    return await originalImportKey(...args);
  } catch {
    const fallbackKey: FallbackCryptoKey = {};
    store.set(fallbackKey, { keyData });
    return fallbackKey;
  }
}

function getAlgorithmName(algorithm: AlgorithmIdentifier | { name?: string }): string {
  const name = typeof algorithm === "string" ? algorithm : algorithm.name;
  return (name ?? "").toUpperCase();
}

function getHmacHash(
  algorithm: AlgorithmIdentifier | HmacImportParams | AesKeyAlgorithm
): NobleHash | undefined {
  if (typeof algorithm === "string") return undefined;
  if (!("hash" in algorithm)) return undefined;
  const hashName = typeof algorithm.hash === "string" ? algorithm.hash : algorithm.hash?.name;
  switch ((hashName ?? "").toUpperCase().replace("_", "-")) {
    case "SHA-256":
      return sha256;
    case "SHA-384":
      return sha384;
    case "SHA-512":
      return sha512;
    default:
      return undefined;
  }
}

function openAesGcm(keyData: Uint8Array, algorithm: AesGcmParams) {
  const iv = toUint8Array(algorithm.iv);
  const aad = algorithm.additionalData ? toUint8Array(algorithm.additionalData) : undefined;
  return gcm(keyData, iv, aad);
}

function toUint8Array(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
