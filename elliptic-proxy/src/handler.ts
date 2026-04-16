// src/handler.ts
import type {
  HttpFunction,
  Request,
  Response,
} from "@google-cloud/functions-framework";
import type { Config } from "./config.js";
import { authenticateRequest, type AuthResult } from "./auth.js";
import { RateLimiter } from "./rate-limit.js";
import { BlockedAddressCache } from "./cache.js";
import { scoreResponse, type ScoringResult } from "./scoring.js";
import type { ForwardResponse } from "./elliptic.js";

export interface ConfigSource {
  get(): Promise<Config>;
}

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

    // StarkNet addresses: "0x" + up to 64 hex chars
    const MAX_ADDRESS_LENGTH = 66;
    if (
      address.length > MAX_ADDRESS_LENGTH ||
      !/^0x[0-9a-fA-F]+$/.test(address)
    ) {
      sendResponse(400, JSON.stringify({ error: "invalid address format" }), {
        partner: partnerName,
      });
      return;
    }
    address = address.toLowerCase();

    // Check cache first — blocked addresses skip the Elliptic call
    if (blockedCache.isBlocked(address)) {
      sendResponse(200, JSON.stringify({ blocked: true }), {
        partner: partnerName,
        result: "cached",
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
      console.error(
        JSON.stringify({
          error: "upstream_request_failed",
          message: error instanceof Error ? error.message : String(error),
        })
      );
      sendResponse(503, JSON.stringify({ error: "service unavailable" }), {
        partner: partnerName,
        result: "error",
        errorType: "network",
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

    sendResponse(200, JSON.stringify({ blocked: scoringResult.blocked }), {
      partner: partnerName,
      ellipticStatus: result.status,
      ellipticLatencyMs: result.durationMs,
      result: blocked ? "blocked" : "allowed",
      scoringReason: scoringResult.reason,
      triggeringRuleIds:
        scoringResult.triggeringRuleIds.length > 0
          ? scoringResult.triggeringRuleIds
          : undefined,
      cacheSize: blockedCache.size,
    });
  };
}
