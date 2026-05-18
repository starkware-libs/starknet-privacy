import { describe, expect, it } from "vitest";
import { CipherSuite } from "hpke";
import { KeyConfig, OHTTPClient, OHTTPServer } from "ohttp-ts";
import { AEAD_AES_128_GCM, KDF_HKDF_SHA256, KEM_DHKEM_X25519_HKDF_SHA256 } from "@panva/hpke-noble";

const suite = new CipherSuite(KEM_DHKEM_X25519_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_128_GCM);

const supportedAlgorithms = [{ kdfId: 0x0001, aeadId: 0x0001 }];

async function createClientAndServer() {
  const serverKey = await KeyConfig.derive(
    suite,
    new Uint8Array(32).fill(7),
    1,
    supportedAlgorithms
  );
  const rawKeyConfig = KeyConfig.serializeMultiple([serverKey]);
  const [clientKey] = KeyConfig.parseMultiple(rawKeyConfig);

  return {
    client: new OHTTPClient(suite, clientKey),
    server: new OHTTPServer([serverKey]),
  };
}

describe("OHTTP noble interop", () => {
  it("roundtrips an HTTP request and response with noble-backed X25519/HKDF/AES", async () => {
    const { client, server } = await createClientAndServer();
    const request = new Request("https://gateway.example/v1/sync/outgoing_state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    const { init, context } = await client.encapsulateRequest(request);
    const outerRequest = new Request("https://relay.example/ohttp", init);
    const { request: innerRequest, context: serverContext } =
      await server.decapsulateRequest(outerRequest);

    expect(innerRequest.method).toBe("POST");
    expect(new URL(innerRequest.url).pathname).toBe("/v1/sync/outgoing_state");
    expect(await innerRequest.json()).toEqual({ hello: "world" });

    const outerResponse = await serverContext.encapsulateResponse(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const innerResponse = await context.decapsulateResponse(outerResponse);

    expect(innerResponse.status).toBe(200);
    expect(await innerResponse.json()).toEqual({ ok: true });
  });

  it("decapsulates a response reconstructed from copied ArrayBuffer bytes", async () => {
    const { client, server } = await createClientAndServer();
    const request = new Request("https://gateway.example/health", { method: "GET" });

    const { init, context } = await client.encapsulateRequest(request);
    const outerRequest = new Request("https://relay.example/ohttp", init);
    const { context: serverContext } = await server.decapsulateRequest(outerRequest);

    const outerResponse = await serverContext.encapsulateResponse(
      new Response(JSON.stringify({ status: "OK" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const copiedBytes = new Uint8Array(await outerResponse.arrayBuffer()).slice();
    const reconstructedResponse = new Response(copiedBytes, {
      status: 200,
      headers: { "content-type": "message/ohttp-res" },
    });

    const innerResponse = await context.decapsulateResponse(reconstructedResponse);

    expect(innerResponse.status).toBe(200);
    expect(await innerResponse.json()).toEqual({ status: "OK" });
  });
});
