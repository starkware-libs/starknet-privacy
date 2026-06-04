// src/handler.ts
import type {
  HttpFunction,
  Request,
  Response,
} from "@google-cloud/functions-framework";
import { HEX_FELT, isMockEllipticUrl, type Config } from "./config.js";
import { authenticateRequest, type AuthResult } from "./auth.js";
import { RateLimiter } from "./rate-limit.js";
import { BlockedAddressCache } from "./cache.js";
import { scoreResponse, type ScoringResult } from "./scoring.js";
import type { ForwardResponse } from "./elliptic.js";
import { signScreening, type ScreeningSignature } from "./signing.js";

export interface ConfigSource {
  get(): Promise<Config>;
}

// StarkNet addresses: "0x" + up to 64 hex chars.
const MAX_ADDRESS_LENGTH = 66;
// A StarkNet ContractAddress is < 2**251. The contract can only ever recompute
// the screening digest over such a value, so signing a larger "address" would
// yield a signature the on-chain verifier can never match — reject it up front.
const ADDRESS_UPPER_BOUND = 2n ** 251n;

export type Forwarder = (request: {
  ellipticUrl: string;
  ellipticKey: string;
  ellipticSecret: string;
  ellipticTimeoutMs: number;
  address: string;
}) => Promise<ForwardResponse>;

function isAuthenticated(
  result: ReturnType<typeof authenticateRequest>
): result is AuthResult {
  return "secret" in result;
}

export function createHandler(
  configSource: ConfigSource,
  forward: Forwarder
): HttpFunction {
  let rateLimiter: RateLimiter | null = null;
  let blockedCache: BlockedAddressCache | null = null;
  let currentCacheTtlMs = 0;

  return async (req: Request, res: Response) => {
    const startTime = Date.now();

    function sendResponse(status: number, body: string, logFields?: object) {
      const latencyMs = Date.now() - startTime;
      console.log(
        JSON.stringify({
          method: req.method,
          path: req.path,
          status,
          latencyMs,
          ...logFields,
        })
      );
      res.set("content-type", "application/json");
      res.status(status).send(body);
    }

    let config: Config;
    try {
      config = await configSource.get();
    } catch (error) {
      console.error(
        JSON.stringify({
          error: "config_load_failed",
          message: error instanceof Error ? error.message : String(error),
        })
      );
      sendResponse(503, JSON.stringify({ error: "service unavailable" }));
      return;
    }

    if (req.rawBody && req.rawBody.length > config.maxBodyBytes) {
      sendResponse(413, JSON.stringify({ error: "payload too large" }), {
        bodyBytes: req.rawBody.length,
        maxBytes: config.maxBodyBytes,
      });
      return;
    }

    if (!rateLimiter) rateLimiter = new RateLimiter();
    const newCacheTtlMs = config.blockedCacheTtlSeconds * 1000;
    if (!blockedCache || newCacheTtlMs !== currentCacheTtlMs) {
      blockedCache = new BlockedAddressCache(newCacheTtlMs);
      currentCacheTtlMs = newCacheTtlMs;
    }

    const authResult = authenticateRequest(req, config);
    if (!isAuthenticated(authResult)) {
      sendResponse(401, JSON.stringify({ error: authResult.error }), {
        partner: authResult.partnerName,
        reason: authResult.reason,
      });
      return;
    }

    const { partnerName } = authResult;

    if (!rateLimiter.check(partnerName, config.rateLimitPerMinute)) {
      sendResponse(429, JSON.stringify({ error: "too many requests" }), {
        partner: partnerName,
        reason: "rate_limited",
      });
      return;
    }

    let address =
      typeof req.body === "object" && req.body !== null
        ? req.body.address
        : undefined;

    if (typeof address !== "string" || address.length === 0) {
      sendResponse(400, JSON.stringify({ error: "missing address" }), {
        partner: partnerName,
      });
      return;
    }

    if (address.length > MAX_ADDRESS_LENGTH || !HEX_FELT.test(address)) {
      sendResponse(400, JSON.stringify({ error: "invalid address format" }), {
        partner: partnerName,
      });
      return;
    }
    address = address.toLowerCase();
    const addressFelt = BigInt(address);

    if (addressFelt >= ADDRESS_UPPER_BOUND) {
      sendResponse(400, JSON.stringify({ error: "invalid address" }), {
        partner: partnerName,
      });
      return;
    }

    const signingKey = config.signingPrivateKey;
    const chainIdFelt = BigInt(config.chainId);

    // Verdicts are labeled with the upstream that produced them: "mock" when
    // the mock Elliptic upstream is selected, "elliptic" otherwise. A repeated
    // mock block is served from the cache and reports "cache" like any cached
    // block.
    const upstreamSource = isMockEllipticUrl(config.elliptic.url)
      ? "mock"
      : "elliptic";

    // Every allowed verdict is signed — the response IS the attestation the
    // caller relays on-chain. Signing runs after the verdict over a fresh
    // timestamp, and the cache only ever stores blocks, so a signature is
    // never cached or stale.
    function sendAllowed(source: string, logFields: Record<string, unknown>) {
      let signature: ScreeningSignature;
      try {
        signature = signScreening(
          signingKey,
          chainIdFelt,
          addressFelt,
          Math.floor(Date.now() / 1000)
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            error: "signing_failed",
            message: error instanceof Error ? error.message : String(error),
          })
        );
        sendResponse(503, JSON.stringify({ error: "signing failed" }), {
          ...logFields,
          source,
          result: "error",
          errorType: "signing",
        });
        return;
      }
      sendResponse(200, JSON.stringify({ blocked: false, source, signature }), {
        ...logFields,
        source,
        result: "allowed",
        signed: true,
      });
    }

    // Check cache first — blocked addresses skip the Elliptic call
    if (blockedCache.isBlocked(address)) {
      sendResponse(200, JSON.stringify({ blocked: true, source: "cache" }), {
        partner: partnerName,
        result: "cached",
        source: "cache",
        cached: true,
        cacheSize: blockedCache.size,
      });
      return;
    }

    let result: ForwardResponse;
    try {
      result = await forward({
        ellipticUrl: config.elliptic.url,
        ellipticKey: config.elliptic.key,
        ellipticSecret: config.elliptic.secret,
        ellipticTimeoutMs: config.elliptic.timeoutMs,
        address,
      });
    } catch (error) {
      // Node's fetch masks transport errors behind a generic "fetch failed"
      // TypeError; the underlying DNS/TCP/TLS reason lives in error.cause.
      const details =
        error instanceof Error
          ? {
              message: error.message,
              name: error.name,
              cause:
                error.cause instanceof Error
                  ? {
                      message: error.cause.message,
                      name: error.cause.name,
                      code: (error.cause as NodeJS.ErrnoException).code,
                    }
                  : error.cause,
            }
          : { message: String(error) };
      console.error(
        JSON.stringify({
          error: "upstream_request_failed",
          url: config.elliptic.url,
          ...details,
        })
      );
      // The proxy itself is healthy; the path to Elliptic is not.
      sendResponse(504, JSON.stringify({ error: "upstream unreachable" }), {
        partner: partnerName,
        result: "error",
        errorType: "network",
      });
      return;
    }

    // Elliptic documents 404 as "Requested subject not found on the
    // blockchain" — e.g. a freshly derived StarkNet address with no on-chain
    // history. There is no exposure to score, so allow the address.
    if (result.status === 404) {
      sendAllowed(upstreamSource, {
        partner: partnerName,
        ellipticStatus: result.status,
        ellipticLatencyMs: result.durationMs,
        scoringReason: "not_in_blockchain",
        cacheSize: blockedCache.size,
      });
      return;
    }

    // Only score successful Elliptic responses — non-2xx indicates an upstream
    // error and must not be interpreted as a screening result.
    if (result.status < 200 || result.status >= 300) {
      console.error(
        JSON.stringify({
          error: "upstream_error",
          ellipticStatus: result.status,
          ellipticBody: result.body.slice(0, 2000),
        })
      );
      sendResponse(502, JSON.stringify({ error: "upstream error" }), {
        partner: partnerName,
        result: "error",
        errorType: "upstream_non_2xx",
        ellipticStatus: result.status,
      });
      return;
    }

    const scoringResult: ScoringResult = scoreResponse(result.body);
    if (scoringResult.reason === "malformed_json") {
      console.error(
        JSON.stringify({
          error: "upstream_malformed_json",
          ellipticStatus: result.status,
          address,
        })
      );
      sendResponse(502, JSON.stringify({ error: "upstream error" }), {
        partner: partnerName,
        result: "error",
        errorType: "malformed_json",
        ellipticStatus: result.status,
      });
      return;
    }

    if (scoringResult.blocked) {
      blockedCache.markBlocked(address);
      sendResponse(
        200,
        JSON.stringify({ blocked: true, source: upstreamSource }),
        {
          partner: partnerName,
          ellipticStatus: result.status,
          ellipticLatencyMs: result.durationMs,
          result: "blocked",
          source: upstreamSource,
          scoringReason: scoringResult.reason,
          triggeringRuleIds:
            scoringResult.triggeringRuleIds.length > 0
              ? scoringResult.triggeringRuleIds
              : undefined,
          cacheSize: blockedCache.size,
        }
      );
      return;
    }

    sendAllowed(upstreamSource, {
      partner: partnerName,
      ellipticStatus: result.status,
      ellipticLatencyMs: result.durationMs,
      scoringReason: scoringResult.reason,
      cacheSize: blockedCache.size,
    });
  };
}
