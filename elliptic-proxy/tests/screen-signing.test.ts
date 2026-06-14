import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPublicKey, verify, Signature } from "@scure/starknet";
import { createHandler } from "../src/handler.js";
import { mockableForwarder } from "../src/mock-elliptic.js";
import { computeScreeningMessageHash } from "../src/signing.js";
import type { ScreeningSignature } from "../src/signing.js";
import type { Config } from "../src/config.js";
import {
  LIVE_CHAIN_ID,
  SCREENING_FIXTURE,
  SIGNING_KEY,
  SN_SEPOLIA_CHAIN_ID,
  makeConfig,
  makeMockEllipticConfig,
  makeRequest,
  makeResponse,
} from "./helpers.js";

// Every allowed POST /screen response carries a screening signature over the
// deployment's configured chain_id; a block never does. These tests cover the
// signing side of the verdict; handler.test.ts covers screening behaviour.
const ALLOWED_ADDRESS =
  "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
const SANCTIONED_ADDRESS = "0xbad";

// Verify a returned signature cryptographically rather than recomputing it
// with signScreening, which would reproduce its own bugs on both sides.
function verifyScreeningSignature(
  signature: ScreeningSignature,
  chainId: string,
  depositor: string
): boolean {
  const messageHash = computeScreeningMessageHash(
    BigInt(chainId),
    BigInt(depositor),
    BigInt(signature.issued_at),
    BigInt(SCREENING_FIXTURE.signer_public_key)
  );
  return verify(
    new Signature(BigInt(signature.sig_r), BigInt(signature.sig_s)),
    "0x" + messageHash.toString(16),
    getPublicKey(SIGNING_KEY)
  );
}

const CLEAN_ELLIPTIC_RESPONSE = {
  status: 200,
  durationMs: 5,
  body: JSON.stringify({
    process_status: "complete",
    evaluation_detail: { source: [], destination: [] },
  }),
};

const BLOCKED_ELLIPTIC_RESPONSE = {
  status: 200,
  durationMs: 5,
  body: JSON.stringify({
    process_status: "complete",
    evaluation_detail: {
      source: [
        {
          rule_id: "1f86dce1-166a-4749-a5df-3972fae7635a",
          matched_elements: [
            {
              contribution_percentage: 5,
              contribution_value: { usd: 100 },
              counterparty_percentage: 10,
              counterparty_value: { usd: 50 },
            },
          ],
        },
      ],
    },
  }),
};

// Sign with the canonical reference key so signatures are reproducible
// against the cross-language vectors.
function makeSigningConfig(overrides: Partial<Config> = {}): Config {
  return makeConfig({ signingPrivateKey: SIGNING_KEY, ...overrides });
}

describe("POST /screen signing", () => {
  const mockForward = vi.fn();

  beforeEach(() => mockForward.mockReset());

  // Wired like production; mockForward stands in for the live forwarder so
  // each test injects the exact Elliptic response its branch needs.
  async function run(address: string, config = makeSigningConfig()) {
    const configSource = { get: vi.fn().mockResolvedValue(config) };
    const handler = createHandler(configSource, mockableForwarder(mockForward));
    const res = makeResponse();
    await handler(makeRequest({}, address), res);
    return res;
  }

  it("signs an Elliptic-backed allow over the configured chain id", async () => {
    mockForward.mockResolvedValue(CLEAN_ELLIPTIC_RESPONSE);
    const before = Math.floor(Date.now() / 1000);
    const res = await run(ALLOWED_ADDRESS);
    const after = Math.floor(Date.now() / 1000);

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.blocked).toBe(false);
    expect(parsed.source).toBe("elliptic");
    expect(mockForward).toHaveBeenCalledOnce();
    // issued_at must be the server's own current second — so a server signing
    // over a different value than it reports (ms, or 0) fails the verify below.
    expect(parsed.signature.issued_at).toBeGreaterThanOrEqual(before);
    expect(parsed.signature.issued_at).toBeLessThanOrEqual(after);
    expect(
      verifyScreeningSignature(parsed.signature, LIVE_CHAIN_ID, ALLOWED_ADDRESS)
    ).toBe(true);
  });

  it("reproduces a committed cross-language vector through the route", async () => {
    // Pin the wall clock to the vector's issued_at: the full route (config
    // chain id → SNIP-12 digest → RFC 6979 signature) must then emit the exact
    // bytes the reference Python signer committed to the fixture.
    const vector = SCREENING_FIXTURE.vectors.find(
      (candidate) => candidate.chain_id === SN_SEPOLIA_CHAIN_ID
    );
    expect(vector).toBeDefined();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(vector!.issued_at * 1000);
      mockForward.mockResolvedValue(CLEAN_ELLIPTIC_RESPONSE);
      const res = await run(
        vector!.depositor,
        makeSigningConfig({ chainId: vector!.chain_id })
      );

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).signature).toEqual({
        issued_at: vector!.issued_at,
        sig_r: vector!.sig_r,
        sig_s: vector!.sig_s,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("signs a 404 not-in-blockchain allow", async () => {
    mockForward.mockResolvedValue({ status: 404, durationMs: 5, body: "{}" });
    const res = await run(ALLOWED_ADDRESS);

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed).toMatchObject({ blocked: false, source: "elliptic" });
    expect(parsed.signature).toBeDefined();
    expect(mockForward).toHaveBeenCalledOnce();
  });

  it("returns blocked:true and no signature for a deny-listed address (mock upstream)", async () => {
    const res = await run(
      SANCTIONED_ADDRESS,
      makeMockEllipticConfig({
        signingPrivateKey: SIGNING_KEY,
        additionalBlockedAddresses: [SANCTIONED_ADDRESS],
      })
    );

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({ blocked: true, source: "blocklist" });
    expect(parsed).not.toHaveProperty("signature");
    expect(mockForward).not.toHaveBeenCalled();
  });

  it("an Elliptic-scored block returns blocked:true and no signature", async () => {
    mockForward.mockResolvedValue(BLOCKED_ELLIPTIC_RESPONSE);
    const res = await run(ALLOWED_ADDRESS);

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({ blocked: true, source: "elliptic" });
    expect(parsed).not.toHaveProperty("signature");
  });

  it("a cached block returns blocked:true source cache, no signature", async () => {
    mockForward.mockResolvedValue(BLOCKED_ELLIPTIC_RESPONSE);
    const configSource = {
      get: vi.fn().mockResolvedValue(makeSigningConfig()),
    };
    const handler = createHandler(configSource, mockableForwarder(mockForward));
    // First request scores a block and populates the blocked-address cache.
    const first = makeResponse();
    await handler(makeRequest({}, ALLOWED_ADDRESS), first);
    expect(JSON.parse(first.body)).toEqual({
      blocked: true,
      source: "elliptic",
    });
    // Same address again hits the cache — no Elliptic call, and a cached block
    // must never carry a signature.
    const second = makeResponse();
    await handler(makeRequest({}, ALLOWED_ADDRESS), second);
    const parsed = JSON.parse(second.body);
    expect(parsed).toEqual({ blocked: true, source: "cache" });
    expect(parsed).not.toHaveProperty("signature");
    expect(mockForward).toHaveBeenCalledOnce();
  });

  it("returns 503 signing-failed when the signer throws (fails closed)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A key the config accepts (non-empty string) but @scure rejects, so
    // signScreening throws inside the allow tail and it must fail closed.
    mockForward.mockResolvedValue(CLEAN_ELLIPTIC_RESPONSE);
    const res = await run(
      ALLOWED_ADDRESS,
      makeConfig({ signingPrivateKey: "0x0" })
    );
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe("signing failed");
    spy.mockRestore();
  });
});
