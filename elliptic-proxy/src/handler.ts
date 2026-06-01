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
import { signScreening, type ScreeningSignature } from "./signing.js";

export interface ConfigSource {
  get(): Promise<Config>;
}

type SendResponse = (status: number, body: string, logFields?: object) => void;

// StarkNet addresses: "0x" + up to 64 hex chars.
const MAX_ADDRESS_LENGTH = 66;
// Any felt252 fits in "0x" + 63 hex chars; cap chain_id with the same bound as
// addresses so an authenticated partner can't hand us an unbounded string.
const MAX_FELT_HEX_LENGTH = 66;
const HEX_FELT = /^0x[0-9a-fA-F]+$/;
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

    // Screening v2: the signing endpoint shares auth + rate-limiting with the
    // legacy /screen path but produces a signed attestation instead of a
    // blocked/allowed verdict. All other paths fall through to /screen.
    if (req.path === "/sign") {
      handleSign(req, config, partnerName, sendResponse);
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

    // Operator overrides take precedence over Elliptic and the cache.
    // blockOverrideAddresses wins over additionalBlockedAddresses so an
    // explicit allow can rescue a globally-denied address.
    if (config.blockOverrideAddresses?.includes(address)) {
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

    if (config.additionalBlockedAddresses?.includes(address)) {
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

    // skipElliptic short-circuits the live screening path. Useful on
    // non-mainnet deployments where Elliptic has no Starknet coverage,
    // or as a kill switch. Operator lists above still apply.
    if (config.skipElliptic) {
      sendResponse(200, JSON.stringify({ blocked: false, source: "skip" }), {
        partner: partnerName,
        result: "allowed",
        source: "skip",
      });
      return;
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
      sendResponse(503, JSON.stringify({ error: "service unavailable" }), {
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
        JSON.stringify({ blocked: false, source: "elliptic" }),
        {
          partner: partnerName,
          ellipticStatus: result.status,
          ellipticLatencyMs: result.durationMs,
          result: "allowed",
          source: "elliptic",
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
      JSON.stringify({ blocked: scoringResult.blocked, source: "elliptic" }),
      {
        partner: partnerName,
        ellipticStatus: result.status,
        ellipticLatencyMs: result.durationMs,
        result: blocked ? "blocked" : "allowed",
        source: "elliptic",
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

/**
 * POST /sign: screen the deposit's source address and, if allowed, return a
 * STARK-curve signature the privacy pool verifies on-chain. Fail-closed — a
 * sanctioned address gets 403 (no signature) and any signing fault gets 503.
 *
 * Screening uses the operator lists: an address is sanctioned iff it is on the
 * deny list (`additionalBlockedAddresses`) and not on the allow list
 * (`blockOverrideAddresses`).
 */
function handleSign(
  req: Request,
  config: Config,
  partnerName: string,
  sendResponse: SendResponse
): void {
  if (!config.signing) {
    sendResponse(503, JSON.stringify({ error: "signing not configured" }), {
      partner: partnerName,
      reason: "signing_unconfigured",
    });
    return;
  }

  const body =
    typeof req.body === "object" && req.body !== null ? req.body : {};

  const rawAddress = body.address;
  if (
    typeof rawAddress !== "string" ||
    rawAddress.length === 0 ||
    rawAddress.length > MAX_ADDRESS_LENGTH ||
    !HEX_FELT.test(rawAddress) ||
    BigInt(rawAddress) >= ADDRESS_UPPER_BOUND
  ) {
    sendResponse(400, JSON.stringify({ error: "invalid address" }), {
      partner: partnerName,
    });
    return;
  }
  const address = rawAddress.toLowerCase();

  const chainId = body.chain_id;
  if (
    typeof chainId !== "string" ||
    chainId.length > MAX_FELT_HEX_LENGTH ||
    !HEX_FELT.test(chainId)
  ) {
    sendResponse(400, JSON.stringify({ error: "invalid chain_id" }), {
      partner: partnerName,
    });
    return;
  }
  if (
    config.signing.allowedChainIds &&
    !config.signing.allowedChainIds.includes(chainId.toLowerCase())
  ) {
    sendResponse(400, JSON.stringify({ error: "unsupported chain_id" }), {
      partner: partnerName,
      reason: "chain_id_not_allowed",
    });
    return;
  }

  // Compare on the canonical felt, not the raw string. The interceptor sends
  // addresses normalized (leading zeros stripped) while operators commonly
  // write deny/allow entries zero-padded to 64 hex — a string compare would
  // silently never match a padded entry and sign a sanctioned address, even
  // though the SAME felt is bound into the digest. Config entries are validated
  // as hex felts at load, so BigInt() here cannot throw.
  const target = BigInt(address);
  const matchesFelt = (list: string[] | undefined): boolean =>
    list?.some((entry) => BigInt(entry) === target) ?? false;
  const allowlisted = matchesFelt(config.blockOverrideAddresses);
  const denylisted = matchesFelt(config.additionalBlockedAddresses);
  if (!allowlisted && denylisted) {
    sendResponse(
      403,
      JSON.stringify({ code: "sanctioned", reason: "OFAC sanctions match" }),
      { partner: partnerName, result: "blocked", source: "blocklist" }
    );
    return;
  }

  const signatureTimestamp = Math.floor(Date.now() / 1000);
  let signature: ScreeningSignature;
  try {
    signature = signScreening(
      config.signing.privateKey,
      BigInt(chainId),
      BigInt(address),
      signatureTimestamp
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        error: "signing_failed",
        message: error instanceof Error ? error.message : String(error),
      })
    );
    sendResponse(503, JSON.stringify({ error: "signing failed" }), {
      partner: partnerName,
      result: "error",
      errorType: "signing",
    });
    return;
  }

  sendResponse(200, JSON.stringify(signature), {
    partner: partnerName,
    result: "allowed",
    source: "signed",
  });
}
