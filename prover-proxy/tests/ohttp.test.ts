// tests/ohttp.test.ts
import { describe, it, expect } from "vitest";
import {
  CipherSuite,
  KEM_DHKEM_X25519_HKDF_SHA256,
  KDF_HKDF_SHA256,
  AEAD_AES_128_GCM,
} from "hpke";
import { KeyConfig, OHTTPClient, AeadId, KdfId } from "ohttp-ts";
import { OhttpGateway } from "../src/ohttp.js";

function createTestClient(keyConfigBytes: Uint8Array): OHTTPClient {
  const suite = new CipherSuite(
    KEM_DHKEM_X25519_HKDF_SHA256,
    KDF_HKDF_SHA256,
    AEAD_AES_128_GCM
  );
  const keyConfigs = KeyConfig.parseMultiple(keyConfigBytes);
  return new OHTTPClient(suite, keyConfigs[0]);
}

describe("OhttpGateway", () => {
  it("generates a gateway with a random key", async () => {
    const gateway = await OhttpGateway.generate();
    expect(gateway).toBeInstanceOf(OhttpGateway);
  });

  it("returns serialized key config bytes", async () => {
    const gateway = await OhttpGateway.generate();
    const keyConfigBytes = gateway.keyConfigBytes();
    expect(keyConfigBytes).toBeInstanceOf(Uint8Array);
    expect(keyConfigBytes.byteLength).toBeGreaterThan(0);

    // Verify the key config can be parsed back
    const configs = KeyConfig.parseMultiple(keyConfigBytes);
    expect(configs).toHaveLength(1);
    expect(configs[0].kemId).toBe(32); // X25519_HKDF_SHA256
    expect(configs[0].symmetricAlgorithms).toHaveLength(1);
    expect(configs[0].symmetricAlgorithms[0].kdfId).toBe(KdfId.HKDF_SHA256);
    expect(configs[0].symmetricAlgorithms[0].aeadId).toBe(AeadId.AES_128_GCM);
  });

  it("generates different keys each time", async () => {
    const gateway1 = await OhttpGateway.generate();
    const gateway2 = await OhttpGateway.generate();
    expect(gateway1.keyConfigBytes()).not.toEqual(gateway2.keyConfigBytes());
  });

  it("round-trips a request through encapsulate/decapsulate", async () => {
    const gateway = await OhttpGateway.generate();
    const client = createTestClient(gateway.keyConfigBytes());

    // Client encapsulates a request
    const innerRequest = new Request("https://target.example/prove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
    });
    const { init, context: clientContext } =
      await client.encapsulateRequest(innerRequest);

    // Gateway decapsulates
    const encapsulatedBody = new Uint8Array(
      init.body instanceof ArrayBuffer
        ? init.body
        : await new Response(init.body).arrayBuffer()
    );
    const { request: decapsulatedRequest, context: serverContext } =
      await gateway.decapsulateRequest(encapsulatedBody);

    // Verify the inner request is recovered correctly
    const decapsulatedBody = await decapsulatedRequest.text();
    expect(JSON.parse(decapsulatedBody)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "test",
    });
    expect(decapsulatedRequest.headers.get("content-type")).toBe(
      "application/json"
    );

    // Server encapsulates a response
    const plainResponse = new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const encapsulatedResponse =
      await serverContext.encapsulateResponse(plainResponse);

    // Client decapsulates the response
    const decapsulatedResponse =
      await clientContext.decapsulateResponse(encapsulatedResponse);
    expect(decapsulatedResponse.status).toBe(200);
    const responseBody = await decapsulatedResponse.json();
    expect(responseBody).toEqual({ jsonrpc: "2.0", id: 1, result: "ok" });
  });

  it("rejects decapsulation with wrong key", async () => {
    const gateway = await OhttpGateway.generate();

    // Create a client with a DIFFERENT gateway's key config
    const otherGateway = await OhttpGateway.generate();
    const client = createTestClient(otherGateway.keyConfigBytes());

    const innerRequest = new Request("https://target.example/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { init } = await client.encapsulateRequest(innerRequest);
    const encapsulatedBody = new Uint8Array(
      init.body instanceof ArrayBuffer
        ? init.body
        : await new Response(init.body).arrayBuffer()
    );

    // Decapsulation with the wrong key should fail
    await expect(
      gateway.decapsulateRequest(encapsulatedBody)
    ).rejects.toThrow();
  });
});
