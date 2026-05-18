/**
 * OHTTP (Oblivious HTTP, RFC 9458) client for encrypting service
 * requests and decrypting responses using HPKE.
 *
 * Wraps the `ohttp-ts` library by Thibault Meunier (Cloudflare).
 */

import { OHTTPClient, KeyConfig } from "ohttp-ts";
import { CipherSuite } from "hpke";
import { AEAD_AES_128_GCM, KDF_HKDF_SHA256, KEM_DHKEM_X25519_HKDF_SHA256 } from "@panva/hpke-noble";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import { ReorgError } from "./errors.js";

/** HTTP 409 — the discovery service returns this exclusively for block reorgs (BLOCK_REORGED). */
const REORG_STATUS = 409;

// Synthetic origin for the inner OHTTP Request URL. The OHTTP gateway routes
// the decapsulated request by path only (axum does not match on Host), so the
// scheme/authority on the inner Request are inert. Using a fixed reserved-TLD
// origin (RFC 6761 `.invalid`) decouples the inner request path from whatever
// outer URL the SDK was configured with — without this, a `gatewayUrl` that
// includes a reverse-proxy path prefix (e.g. `/discovery`) leaks into the
// inner path and produces a 404 when the gateway server tries to route it.
const INNER_REQUEST_ORIGIN = "https://ohttp-target.invalid";

/**
 * Polyfill crypto.subtle for HMAC and AES-GCM on React Native.
 *
 * ohttp-ts uses crypto.subtle internally for OHTTP response decryption
 * (extractPrk / expandPrk / openWithRawAead), but React Native's
 * react-native-quick-crypto doesn't implement HMAC or AES-GCM through
 * the SubtleCrypto interface. This patches them using noble as a
 * transparent fallback — on platforms where native WebCrypto works
 * (Chrome, Node), the original functions succeed and the fallback
 * never triggers.
 */
let didPolyfillSubtle = false;
function polyfillSubtleIfNeeded(): void {
  if (didPolyfillSubtle) return;
  didPolyfillSubtle = true;
  if (typeof globalThis.crypto?.subtle?.importKey !== "function") return;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const subtle = globalThis.crypto.subtle as any;
  const originalImportKey = subtle.importKey.bind(subtle);
  const originalSign = subtle.sign?.bind(subtle);
  const originalEncrypt = subtle.encrypt?.bind(subtle);
  const originalDecrypt = subtle.decrypt?.bind(subtle);

  const hmacKeys = new WeakMap<object, { keyData: Uint8Array }>();
  const aesKeys = new WeakMap<object, { keyData: Uint8Array }>();

  subtle.importKey = async function patchedImportKey(
    format: string,
    keyData: any,
    algorithm: any,
    extractable: boolean,
    keyUsages: string[]
  ): Promise<any> {
    const algName = (algorithm?.name ?? "").toUpperCase();
    const hashName = typeof algorithm?.hash === "string" ? algorithm.hash : algorithm?.hash?.name;
    const raw = keyData instanceof Uint8Array ? keyData : new Uint8Array(keyData);

    if (format === "raw" && algName === "HMAC" && hashName) {
      try {
        return await originalImportKey(format, keyData, algorithm, extractable, keyUsages);
      } catch {
        const h = {} as any;
        hmacKeys.set(h, { keyData: raw });
        return h;
      }
    }
    if (format === "raw" && algName === "AES-GCM") {
      try {
        return await originalImportKey(format, keyData, algorithm, extractable, keyUsages);
      } catch {
        const h = {} as any;
        aesKeys.set(h, { keyData: raw });
        return h;
      }
    }
    return originalImportKey(format, keyData, algorithm, extractable, keyUsages);
  };

  subtle.sign = async function patchedSign(algorithm: any, key: any, data: any): Promise<any> {
    const hk = hmacKeys.get(key);
    if (hk) {
      const d = data instanceof Uint8Array ? data : new Uint8Array(data);
      return hmac(sha256, hk.keyData, d).buffer;
    }
    return originalSign!(algorithm, key, data);
  };

  subtle.encrypt = async function patchedEncrypt(
    algorithm: any,
    key: any,
    data: any
  ): Promise<any> {
    const ak = aesKeys.get(key);
    if (ak) {
      const iv = algorithm.iv instanceof Uint8Array ? algorithm.iv : new Uint8Array(algorithm.iv);
      const aad = algorithm.additionalData
        ? algorithm.additionalData instanceof Uint8Array
          ? algorithm.additionalData
          : new Uint8Array(algorithm.additionalData)
        : undefined;
      const pt = data instanceof Uint8Array ? data : new Uint8Array(data);
      return gcm(ak.keyData, iv, aad).encrypt(pt).buffer;
    }
    return originalEncrypt!(algorithm, key, data);
  };

  subtle.decrypt = async function patchedDecrypt(
    algorithm: any,
    key: any,
    data: any
  ): Promise<any> {
    const ak = aesKeys.get(key);
    if (ak) {
      const iv = algorithm.iv instanceof Uint8Array ? algorithm.iv : new Uint8Array(algorithm.iv);
      const aad = algorithm.additionalData
        ? algorithm.additionalData instanceof Uint8Array
          ? algorithm.additionalData
          : new Uint8Array(algorithm.additionalData)
        : undefined;
      const ct = data instanceof Uint8Array ? data : new Uint8Array(data);
      return gcm(ak.keyData, iv, aad).decrypt(ct).buffer;
    }
    return originalDecrypt!(algorithm, key, data);
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Configuration for enabling OHTTP. `true` uses defaults; an object allows custom relay/key config. */
export type OhttpOption = boolean | { relayUrl?: string; publicKeyConfig?: Uint8Array };

/**
 * OHTTP client that encrypts requests and decrypts responses.
 *
 * Fetches the server's HPKE key config from `GET /ohttp-keys`
 * and uses it to encapsulate requests as `message/ohttp-req`.
 */
export class OhttpClient {
  private ohttpClient: OHTTPClient | null = null;
  private readonly pinnedKeyConfig: Uint8Array | undefined;

  /**
   * @param gatewayUrl - URL where the OHTTP gateway accepts encapsulated requests
   *   and serves `/ohttp-keys`. May include a reverse-proxy path prefix (e.g.
   *   `https://api.example.com/discovery`); the prefix is preserved on outer
   *   requests but stripped from the inner OHTTP request path (which always
   *   uses just the supplied per-call `path`).
   *   Must be HTTPS in production — without it (or a pinned `publicKeyConfig`),
   *   an active network attacker can replace the OHTTP key config.
   * @param options.relayUrl - Optional OHTTP relay URL. When set, encapsulated
   *   requests are sent here instead of the gateway. `/ohttp-keys` is still
   *   fetched from `gatewayUrl`.
   * @param options.publicKeyConfig - Optional pinned key config bytes
   *   (`application/ohttp-keys` format). When set, `/ohttp-keys` is never fetched.
   */
  constructor(
    private readonly gatewayUrl: string,
    options?: { relayUrl?: string; publicKeyConfig?: Uint8Array }
  ) {
    polyfillSubtleIfNeeded();
    this.pinnedKeyConfig = options?.publicKeyConfig;
    if (options?.relayUrl) {
      this.relayUrl = options.relayUrl;
    }
  }

  private relayUrl?: string;

  /**
   * Send an OHTTP-encapsulated GET request and return the decrypted JSON response.
   */
  async get<T>(path: string): Promise<T> {
    return this.send<T>(path, new Request(`${INNER_REQUEST_ORIGIN}${path}`, { method: "GET" }));
  }

  /**
   * Send an OHTTP-encapsulated POST request and return the decrypted JSON response.
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(
      path,
      new Request(`${INNER_REQUEST_ORIGIN}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  }

  private async send<T>(path: string, request: Request): Promise<T> {
    await this.ensureClient();

    const { init, context } = await this.ohttpClient!.encapsulateRequest(request);

    const targetUrl = this.relayUrl ?? this.gatewayUrl;
    const response = await fetch(targetUrl, init);

    // Pre-decryption errors come as plain HTTP responses
    if (response.status === 422) {
      this.invalidate();
      const text = await response.text().catch(() => "");
      throw new Error(`OHTTP decapsulation failed on server: ${text}`);
    }

    // Defense-in-depth: catch non-encapsulated error responses (e.g. from a relay).
    // In normal OHTTP operation, error responses are encapsulated and handled below.
    if (!response.ok && response.headers.get("content-type") !== "message/ohttp-res") {
      const text = await response.text().catch(() => "");
      if (response.status === REORG_STATUS) {
        throw new ReorgError(`Block reorged during ${path}: ${text}`);
      }
      throw new Error(`OHTTP request ${path} failed (${response.status}): ${text}`);
    }

    // Decrypt the OHTTP response
    const innerResponse = await context.decapsulateResponse(response);

    // The reconstructed Response from decapsulateResponse does not auto-decompress
    // Content-Encoding (unlike fetch). Handle gzip/deflate explicitly.
    const innerBody = await readResponseText(innerResponse);

    // The OHTTP server encapsulates all API responses (including errors) inside the
    // envelope with outer status 200. A 409 BLOCK_REORGED from the discovery API
    // appears here as the inner HTTP status — this is the primary reorg detection path.
    if (innerResponse.status === REORG_STATUS) {
      throw new ReorgError(`Block reorged during ${path}: ${innerBody}`);
    }

    if (innerResponse.status !== 200) {
      throw new Error(
        `OHTTP inner response ${path} failed (${innerResponse.status}): ${innerBody}`
      );
    }

    return JSON.parse(innerBody) as T;
  }

  /** Fetch (or use pinned) key config and create the OHTTPClient. */
  private async ensureClient(): Promise<void> {
    if (this.ohttpClient) {
      return;
    }

    let raw: Uint8Array;
    if (this.pinnedKeyConfig) {
      raw = this.pinnedKeyConfig;
    } else {
      const response = await fetch(`${this.gatewayUrl}/ohttp-keys`);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch OHTTP key config: ${response.status} ${response.statusText}`
        );
      }
      raw = new Uint8Array(await response.arrayBuffer());
    }

    // The /ohttp-keys endpoint returns `application/ohttp-keys` list format (RFC 9458 §3.2)
    // with 2-byte length prefixes per entry. KeyConfig.parse (single) does not handle
    // length prefixes, so parseMultiple is the correct parser for this wire format.
    const publicKeyConfigs = KeyConfig.parseMultiple(raw);
    if (publicKeyConfigs.length === 0) {
      throw new Error("OHTTP key config response contained no key configurations");
    }
    const publicKeyConfig = publicKeyConfigs[0];
    const suite = new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_128_GCM);
    this.ohttpClient = new OHTTPClient(suite, publicKeyConfig);
  }

  private invalidate(): void {
    this.ohttpClient = null;
  }
}

/** Supported Content-Encoding → DecompressionStream format mapping. */
const ENCODING_TO_FORMAT: Record<string, CompressionFormat> = {
  gzip: "gzip",
  "x-gzip": "gzip",
  deflate: "deflate",
};

/**
 * Read the body text from a Response, decompressing if Content-Encoding is set.
 * The Response objects from ohttp-ts decapsulateResponse do not auto-decompress
 * like fetch() responses do, so we handle gzip/deflate explicitly via DecompressionStream.
 */
async function readResponseText(response: Response): Promise<string> {
  const encoding = response.headers.get("content-encoding")?.toLowerCase();
  if (!encoding || !response.body || encoding === "identity") {
    return response.text();
  }
  const format = ENCODING_TO_FORMAT[encoding];
  if (!format) {
    // DecompressionStream only supports gzip and deflate per the Compression Streams spec.
    // Brotli (br) and zstd are not universally available across runtimes.
    throw new Error(`Unsupported Content-Encoding in OHTTP response: ${encoding}`);
  }
  const decompressed = response.body.pipeThrough(new DecompressionStream(format));
  return new Response(decompressed).text();
}
