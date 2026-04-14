// src/ohttp.ts
//
// The proxy runs as a single instance, so the OHTTP key pair is generated
// at startup rather than loaded from configuration. Clients fetch the
// public key via GET /ohttp-keys before each session.

import {
  CipherSuite,
  KEM_DHKEM_X25519_HKDF_SHA256,
  KDF_HKDF_SHA256,
  AEAD_AES_128_GCM,
} from "hpke";
import {
  AeadId,
  KdfId,
  KeyConfig,
  OHTTPServer,
  MediaType,
  type HttpServerContext,
} from "ohttp-ts";
import { x25519 } from "@noble/curves/ed25519";
import { randomBytes } from "node:crypto";

export type OhttpServerContext = HttpServerContext;

const SYMMETRIC_ALGORITHMS = [
  { kdfId: KdfId.HKDF_SHA256, aeadId: AeadId.AES_128_GCM },
] as const;

const KEY_ID = 0x01;

export class OhttpGateway {
  private readonly server: OHTTPServer;
  private readonly serializedKeyConfig: Uint8Array;

  private constructor(server: OHTTPServer, serializedKeyConfig: Uint8Array) {
    this.server = server;
    this.serializedKeyConfig = serializedKeyConfig;
  }

  /** Generate a fresh X25519 key pair and build the gateway. */
  static async generate(): Promise<OhttpGateway> {
    const privateKeyBytes = randomBytes(32);
    const publicKeyBytes = x25519.getPublicKey(privateKeyBytes);

    const suite = new CipherSuite(
      KEM_DHKEM_X25519_HKDF_SHA256,
      KDF_HKDF_SHA256,
      AEAD_AES_128_GCM
    );

    const keyConfig = await KeyConfig.import(
      suite,
      KEY_ID,
      publicKeyBytes,
      privateKeyBytes,
      SYMMETRIC_ALGORITHMS
    );

    const server = new OHTTPServer([keyConfig]);
    const serializedKeyConfig = KeyConfig.serializeMultiple([keyConfig]);
    return new OhttpGateway(server, serializedKeyConfig);
  }

  keyConfigBytes(): Uint8Array {
    return this.serializedKeyConfig;
  }

  async decapsulateRequest(
    body: Uint8Array
  ): Promise<{ request: Request; context: HttpServerContext }> {
    const ohttpRequest = new Request("https://localhost/", {
      method: "POST",
      headers: { "content-type": MediaType.REQUEST },
      body: Buffer.from(body),
    });
    return this.server.decapsulateRequest(ohttpRequest);
  }
}
