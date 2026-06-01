import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "@google-cloud/functions-framework";
import { createHandler } from "../src/handler.js";
import { computeHmacSignature } from "../src/auth.js";
import { signScreening } from "../src/signing.js";
import type { Config } from "../src/config.js";

const PARTNER_SECRET = Buffer.from("partner-secret").toString("base64");
const CHAIN_ID = "0x534e5f5345504f4c4941"; // SN_SEPOLIA felt
const ALLOWED_ADDRESS =
  "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
const SANCTIONED_ADDRESS = "0xbad";

// Reuse the F1 reference key so the route's signature is reproducible here.
const SIGNING_KEY = (
  JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "fixtures",
        "screening-vectors.json"
      ),
      "utf8"
    )
  ) as { private_key: string }
).private_key;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    elliptic: {
      url: "https://api.elliptic.co",
      key: "elliptic-key",
      secret: Buffer.from("elliptic-secret").toString("base64"),
      timeoutMs: 10000,
    },
    rateLimitPerMinute: 100,
    maxBodyBytes: 10240,
    configCacheTtlSeconds: 300,
    blockedCacheTtlSeconds: 300,
    partners: { "test-partner": PARTNER_SECRET },
    additionalBlockedAddresses: [SANCTIONED_ADDRESS],
    signing: { privateKey: SIGNING_KEY },
    ...overrides,
  };
}

function makeSignRequest(
  payload: Record<string, unknown> = {
    address: ALLOWED_ADDRESS,
    chain_id: CHAIN_ID,
  },
  overrides: Record<string, unknown> = {}
): Request {
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const signature = computeHmacSignature(
    PARTNER_SECRET,
    timestamp,
    "POST",
    "/sign",
    body
  );
  return {
    method: "POST",
    path: "/sign",
    headers: {
      "x-access-key": "test-partner",
      "x-access-sign": signature,
      "x-access-timestamp": timestamp,
    },
    rawBody: Buffer.from(body),
    body: payload,
    ...overrides,
  } as unknown as Request;
}

function makeResponse(): Response & { statusCode: number; body: string } {
  const res = {
    statusCode: 200,
    body: "",
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    set() {
      return res;
    },
    send(body: string) {
      res.body = body;
      return res;
    },
  };
  return res as Response & typeof res;
}

const noForward = vi.fn();

async function run(req: Request, config: Config = makeConfig()) {
  const handler = createHandler(
    { get: vi.fn().mockResolvedValue(config) },
    noForward
  );
  const res = makeResponse();
  await handler(req, res);
  return res;
}

describe("POST /sign", () => {
  it("returns a reproducible signature for an allowed address", async () => {
    const res = await run(makeSignRequest());

    expect(res.statusCode).toBe(200);
    const signed = JSON.parse(res.body);
    expect(signed).toHaveProperty("signature_timestamp");
    expect(signed).toHaveProperty("sig_r");
    expect(signed).toHaveProperty("sig_s");
    // Recompute against the server-chosen timestamp: proves the route signed
    // the correct digest with the configured key.
    const expected = signScreening(
      SIGNING_KEY,
      BigInt(CHAIN_ID),
      BigInt(ALLOWED_ADDRESS),
      signed.signature_timestamp
    );
    expect(signed).toEqual(expected);
    expect(noForward).not.toHaveBeenCalled();
  });

  it("returns 403 for a sanctioned address (no signature)", async () => {
    const res = await run(
      makeSignRequest({ address: SANCTIONED_ADDRESS, chain_id: CHAIN_ID })
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ code: "sanctioned" });
  });

  it("allowlist override rescues a denylisted address", async () => {
    const res = await run(
      makeSignRequest({ address: SANCTIONED_ADDRESS, chain_id: CHAIN_ID }),
      makeConfig({ blockOverrideAddresses: [SANCTIONED_ADDRESS] })
    );
    expect(res.statusCode).toBe(200);
  });

  it("blocks a sanctioned address regardless of zero-padding or casing", async () => {
    // Operators write deny entries zero-padded to 64 hex; the interceptor sends
    // the felt with leading zeros stripped. A string compare would miss the
    // match and sign the sanctioned address — the numeric compare must not.
    const padded =
      "0x000000000000000000000000000000000000000000000000000000000000bad0";
    const stripped = "0xBAD0"; // different string, same felt, mixed case
    const res = await run(
      makeSignRequest({ address: stripped, chain_id: CHAIN_ID }),
      makeConfig({ additionalBlockedAddresses: [padded] })
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ code: "sanctioned" });
  });

  it("returns 400 for an address >= 2**251 (out of felt range)", async () => {
    const tooLarge = "0x" + "f".repeat(64); // 2**256-1, beyond the address bound
    const res = await run(
      makeSignRequest({ address: tooLarge, chain_id: CHAIN_ID })
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when address is missing", async () => {
    const res = await run(makeSignRequest({ chain_id: CHAIN_ID }));
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when chain_id is missing or malformed", async () => {
    const res = await run(makeSignRequest({ address: ALLOWED_ADDRESS }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/chain_id/);
  });

  it("returns 400 for a chain_id outside the configured allowlist", async () => {
    const res = await run(
      makeSignRequest({ address: ALLOWED_ADDRESS, chain_id: "0xdead" }),
      makeConfig({
        signing: { privateKey: SIGNING_KEY, allowedChainIds: [CHAIN_ID] },
      })
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 503 when signing is not configured", async () => {
    const res = await run(
      makeSignRequest(),
      makeConfig({ signing: undefined })
    );
    expect(res.statusCode).toBe(503);
  });

  it("returns 401 when the HMAC is signed for the wrong path", async () => {
    const body = JSON.stringify({
      address: ALLOWED_ADDRESS,
      chain_id: CHAIN_ID,
    });
    const timestamp = Date.now().toString();
    // Sign "/screen" but send to "/sign" — signature must not validate.
    const signature = computeHmacSignature(
      PARTNER_SECRET,
      timestamp,
      "POST",
      "/screen",
      body
    );
    const req = {
      method: "POST",
      path: "/sign",
      headers: {
        "x-access-key": "test-partner",
        "x-access-sign": signature,
        "x-access-timestamp": timestamp,
      },
      rawBody: Buffer.from(body),
      body: { address: ALLOWED_ADDRESS, chain_id: CHAIN_ID },
    } as unknown as Request;
    const res = await run(req);
    expect(res.statusCode).toBe(401);
  });
});
