// src/handler.ts
import type {
  HttpFunction,
  Request,
  Response,
} from "@google-cloud/functions-framework";
import type { Config } from "./config.js";
import { authenticateRequest, type AuthResult } from "./auth.js";
import { RateLimiter } from "./rate-limit.js";
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
  const rateLimiter = new RateLimiter();

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

    const authResult = authenticateRequest(req, config);
    if (!isAuthenticated(authResult)) {
      sendResponse(401, JSON.stringify({ error: authResult.error }), {
        partner: authResult.partnerName,
        reason: authResult.reason,
      });
      return;
    }

    const { partnerName } = authResult;

    if (req.rawBody && req.rawBody.length > config.maxBodyBytes) {
      sendResponse(413, JSON.stringify({ error: "payload too large" }), {
        partner: partnerName,
        bodyBytes: req.rawBody.length,
        maxBytes: config.maxBodyBytes,
      });
      return;
    }

    if (!rateLimiter.check(partnerName, config.rateLimitPerMinute)) {
      sendResponse(429, JSON.stringify({ error: "too many requests" }), {
        partner: partnerName,
        reason: "rate_limited",
      });
      return;
    }

    const address =
      typeof req.body === "object" && req.body !== null
        ? req.body.address
        : undefined;

    if (typeof address !== "string" || address.length === 0) {
      sendResponse(400, JSON.stringify({ error: "missing address" }), {
        partner: partnerName,
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
        reason: "upstream_request_failed",
      });
      return;
    }

    if (result.status < 200 || result.status >= 300) {
      console.error(
        JSON.stringify({
          error: "upstream_error",
          ellipticStatus: result.status,
        })
      );
      sendResponse(502, JSON.stringify({ error: "upstream error" }), {
        partner: partnerName,
        reason: "upstream_non_2xx",
        ellipticStatus: result.status,
      });
      return;
    }

    // TODO: Replace hardcoded response with rule-based scoring
    const blocked = true;

    sendResponse(200, JSON.stringify({ blocked }), {
      partner: partnerName,
      ellipticStatus: result.status,
    });
  };
}
