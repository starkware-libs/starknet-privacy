// src/handler.ts
import type {
  HttpFunction,
  Request,
  Response,
} from "@google-cloud/functions-framework";
import { isMockEllipticUrl, type Config } from "./config.js";
import { feltListIncludes, isHexFelt } from "./felt.js";
import { authenticateRequest, type AuthResult } from "./auth.js";
import { RateLimiter } from "./rate-limit.js";
import { BlockedAddressCache } from "./cache.js";
import { scoreResponse, type ScoringResult } from "./scoring.js";
import type { ForwardResponse } from "./elliptic.js";

export interface ConfigSource {
  get(): Promise<Config>;
}

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

    if (!isHexFelt(address)) {
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

    // Operator lists take precedence over the cache and the upstream verdict,
    // in every mode. The allow list wins over the deny list so an explicit
    // allow can rescue a wrongly-flagged address (upstream false positive);
    // the deny list covers addresses the upstream misses (false negative).
    // Both match on the canonical felt, so zero-padded entries match the
    // leading-zero-stripped addresses callers send.
    if (feltListIncludes(config.blockOverrideAddresses, addressFelt)) {
      sendResponse(
        200,
        JSON.stringify({ blocked: false, source: "allowlist" }),
        {
          partner: partnerName,
          result: "allowed",
          source: "allowlist",
        }
      );
      return;
    }

    if (feltListIncludes(config.additionalBlockedAddresses, addressFelt)) {
      sendResponse(
        200,
        JSON.stringify({ blocked: true, source: "blocklist" }),
        {
          partner: partnerName,
          result: "blocked",
          source: "blocklist",
        }
      );
      return;
    }

    // Verdicts are labeled with the upstream that produced them: "mock" when
    // the mock Elliptic upstream is selected, "elliptic" otherwise.
    const upstreamSource = isMockEllipticUrl(config.elliptic.url)
      ? "mock"
      : "elliptic";

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
      sendResponse(
        200,
        JSON.stringify({ blocked: false, source: upstreamSource }),
        {
          partner: partnerName,
          ellipticStatus: result.status,
          ellipticLatencyMs: result.durationMs,
          result: "allowed",
          source: upstreamSource,
          scoringReason: "not_in_blockchain",
          cacheSize: blockedCache.size,
        }
      );
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

    const blocked = scoringResult.blocked;
    if (blocked) {
      blockedCache.markBlocked(address);
    }

    sendResponse(
      200,
      JSON.stringify({
        blocked: scoringResult.blocked,
        source: upstreamSource,
      }),
      {
        partner: partnerName,
        ellipticStatus: result.status,
        ellipticLatencyMs: result.durationMs,
        result: blocked ? "blocked" : "allowed",
        source: upstreamSource,
        scoringReason: scoringResult.reason,
        triggeringRuleIds:
          scoringResult.triggeringRuleIds.length > 0
            ? scoringResult.triggeringRuleIds
            : undefined,
        cacheSize: blockedCache.size,
      }
    );
  };
}
