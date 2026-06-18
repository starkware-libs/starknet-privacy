// tests/byok.test.ts
import { describe, it, expect, vi } from "vitest";
import { createHandler } from "../src/handler.js";
import {
  makeConfig,
  makeByokRequest,
  makeResponse,
  BYOK_ELLIPTIC_KEY,
  BYOK_ELLIPTIC_SECRET,
} from "./helpers.js";

// An upstream reply the handler treats as "not on chain" → allowed + signed.
const NOT_ON_CHAIN = { status: 404, body: "", durationMs: 5 };

function handlerFor(configOverrides = {}, forward = vi.fn()) {
  const config = makeConfig({ allowByok: true, ...configOverrides });
  const configLoader = { get: vi.fn().mockResolvedValue(config) };
  return { handler: createHandler(configLoader, forward), forward };
}

describe("BYOK screening path", () => {
  it("forwards the client's Elliptic credentials and signs the verdict", async () => {
    const { handler, forward } = handlerFor();
    forward.mockResolvedValue(NOT_ON_CHAIN);
    const res = makeResponse();
    await handler(makeByokRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        ellipticKey: BYOK_ELLIPTIC_KEY,
        ellipticSecret: BYOK_ELLIPTIC_SECRET,
        address: "0xabc123",
      })
    );
    const verdict = JSON.parse(res.body);
    expect(verdict).toMatchObject({ blocked: false, source: "byok" });
    // BYOK verdicts are signed with the proxy key, exactly like partners.
    expect(verdict.signature).toBeDefined();
  });

  it("returns 401 byok_disabled when the gate is off", async () => {
    const { handler, forward } = handlerFor({ allowByok: false });
    const res = makeResponse();
    await handler(makeByokRequest(), res);
    expect(res.statusCode).toBe(401);
    expect(forward).not.toHaveBeenCalled();
  });

  it("returns 401 when only one Elliptic header is present", async () => {
    const { handler, forward } = handlerFor();
    const req = makeByokRequest({
      headers: {
        "x-elliptic-key": BYOK_ELLIPTIC_KEY,
        "x-access-sign": "ignored",
        "x-access-timestamp": Date.now().toString(),
      },
    });
    const res = makeResponse();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(forward).not.toHaveBeenCalled();
  });

  it("returns 401 when the self-signed HMAC is wrong", async () => {
    const { handler, forward } = handlerFor();
    const req = makeByokRequest();
    (req.headers as Record<string, string>)["x-access-sign"] = "bad-signature";
    const res = makeResponse();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(forward).not.toHaveBeenCalled();
  });

  it("maps an upstream 401 to 'elliptic rejected credentials' (not 502)", async () => {
    const { handler, forward } = handlerFor();
    forward.mockResolvedValue({ status: 401, body: "{}", durationMs: 5 });
    const res = makeResponse();
    await handler(makeByokRequest(), res);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("elliptic rejected credentials");
  });

  it("never leaks the client Elliptic secret in the response or logs", async () => {
    const captured: string[] = [];
    const sink = (...args: unknown[]) => captured.push(args.join(" "));
    const logSpy = vi.spyOn(console, "log").mockImplementation(sink);
    const errSpy = vi.spyOn(console, "error").mockImplementation(sink);

    const { handler, forward } = handlerFor();
    forward.mockResolvedValue(NOT_ON_CHAIN);
    const res = makeResponse();
    await handler(makeByokRequest(), res);

    logSpy.mockRestore();
    errSpy.mockRestore();

    const haystack = res.body + "\n" + captured.join("\n");
    expect(haystack).not.toContain(BYOK_ELLIPTIC_SECRET);
    // The pre-base64 secret value must not appear either.
    expect(haystack).not.toContain("client-elliptic-secret");
  });
});
