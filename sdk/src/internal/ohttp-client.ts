/**
 * OHTTP (Oblivious HTTP, RFC 9458) client for encrypting discovery service
 * requests and decrypting responses using HPKE.
 *
 * Wraps the `ohttp-ts` library by Thibault Meunier (Cloudflare).
 */

import { OHTTPClient, KeyConfig } from "ohttp-ts";
import { CipherSuite, KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_128_GCM } from "hpke";

// Cache TTL for key config (1 hour)
const KEY_CONFIG_TTL_MS = 3600_000;

/** Error thrown when a block reorg is detected (HTTP 409 inner status). */
export class ReorgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReorgError";
  }
}

/**
 * OHTTP client that encrypts requests and decrypts responses.
 *
 * Fetches the server's HPKE key config from `GET /ohttp-keys`, caches it,
 * and uses it to encapsulate POST requests as `message/ohttp-req`.
 */
export class OhttpClient {
  private ohttpClient: OHTTPClient | null = null;
  private publicKeyConfigFetchedAt = 0;
  private readonly pinnedKeyConfig: Uint8Array | undefined;

  /**
   * @param gatewayUrl - Discovery service base URL (used for `/ohttp-keys` and as default target)
   * @param options.relayUrl - Optional OHTTP relay URL. When set, encapsulated requests are sent here instead of the gateway.
   * @param options.publicKeyConfig - Optional pinned key config bytes (`application/ohttp-keys` format). When set, `/ohttp-keys` is never fetched.
   */
  constructor(
    private readonly gatewayUrl: string,
    options?: { relayUrl?: string; publicKeyConfig?: Uint8Array }
  ) {
    this.pinnedKeyConfig = options?.publicKeyConfig;
    if (options?.relayUrl) {
      this.relayUrl = options.relayUrl;
    }

    if (!this.pinnedKeyConfig) {
      const url = new URL(gatewayUrl);
      const isLocalDev = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !isLocalDev) {
        console.warn(
          "OhttpClient: gatewayUrl is not HTTPS and no publicKeyConfig is pinned. " +
            "An active network attacker could replace the OHTTP key config. " +
            "Use HTTPS or pin a publicKeyConfig for production deployments."
        );
      }
    }
  }

  private relayUrl?: string;

  /**
   * Send an OHTTP-encapsulated GET request and return the decrypted JSON response.
   */
  async get<T>(path: string): Promise<T> {
    return this.send<T>(path, new Request(`${this.gatewayUrl}${path}`, { method: "GET" }));
  }

  /**
   * Send an OHTTP-encapsulated POST request and return the decrypted JSON response.
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(
      path,
      new Request(`${this.gatewayUrl}${path}`, {
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

    if (!response.ok && response.headers.get("content-type") !== "message/ohttp-res") {
      const text = await response.text().catch(() => "");
      if (response.status === 409) {
        throw new ReorgError(`Block reorged during ${path}: ${text}`);
      }
      throw new Error(`OHTTP request ${path} failed (${response.status}): ${text}`);
    }

    // Decrypt the OHTTP response
    const innerResponse = await context.decapsulateResponse(response);
    const innerBody = await innerResponse.text();

    if (innerResponse.status === 409) {
      throw new ReorgError(`Block reorged during ${path}: ${innerBody}`);
    }

    if (innerResponse.status < 200 || innerResponse.status >= 300) {
      throw new Error(`Indexer API ${path} failed (${innerResponse.status}): ${innerBody}`);
    }

    return JSON.parse(innerBody) as T;
  }

  /** Fetch (or use pinned) key config and create the OHTTPClient. */
  private async ensureClient(): Promise<void> {
    const now = Date.now();
    if (this.ohttpClient && now - this.publicKeyConfigFetchedAt < KEY_CONFIG_TTL_MS) {
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

    const publicKeyConfigs = KeyConfig.parseMultiple(raw);
    const publicKeyConfig = publicKeyConfigs[0];
    const suite = new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_128_GCM);
    this.ohttpClient = new OHTTPClient(suite, publicKeyConfig);
    this.publicKeyConfigFetchedAt = now;
  }

  private invalidate(): void {
    this.ohttpClient = null;
    this.publicKeyConfigFetchedAt = 0;
  }
}
