// src/auth.ts
import { createHash, createHmac, timingSafeEqual } from "crypto";
import type { Request } from "@google-cloud/functions-framework";
import type { Config } from "./config.js";

const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

export interface AuthResult {
  partnerName: string;
  secret: string;
  // Set for a BYOK request: the client is not a registered partner but supplied
  // its own Elliptic credentials, which the proxy re-signs the upstream call
  // with. partnerName is then a synthetic "byok:<hash>" id used only for
  // rate-limiting and logging (never the raw key).
  byok?: boolean;
  ellipticKey?: string;
  ellipticSecret?: string;
}

export function authenticateRequest(
  req: Request,
  config: Config
): AuthResult | { error: string; reason: string; partnerName?: string } {
  const partnerName = firstValue(req.headers["x-access-key"]);
  const accessSign = firstValue(req.headers["x-access-sign"]);
  const accessTimestamp = firstValue(req.headers["x-access-timestamp"]);
  const ellipticKey = firstValue(req.headers["x-elliptic-key"]);
  const ellipticSecret = firstValue(req.headers["x-elliptic-secret"]);

  // Both the partner and BYOK paths authenticate with a timestamped HMAC.
  if (!accessSign || !accessTimestamp) {
    return { error: "unauthorized", reason: "missing_headers", partnerName };
  }

  const timestampMs = Number(accessTimestamp);
  if (
    Number.isNaN(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_DRIFT_MS
  ) {
    return { error: "unauthorized", reason: "timestamp_expired", partnerName };
  }

  const rawBody = req.rawBody?.toString() ?? "";

  // Registered partner: HMAC keyed by the partner's stored hmacSecret. A known
  // partner always takes this path, so a BYOK header can never shadow one.
  if (partnerName && Object.hasOwn(config.partners, partnerName)) {
    const partnerSecret = config.partners[partnerName].hmacSecret;
    if (
      !verifySignature(
        partnerSecret,
        accessSign,
        accessTimestamp,
        req.method,
        req.path,
        rawBody
      )
    ) {
      return {
        error: "unauthorized",
        reason: "invalid_signature",
        partnerName,
      };
    }
    return { partnerName, secret: partnerSecret };
  }

  // BYOK: the client supplies its own Elliptic key + secret and self-signs the
  // request with that secret — proving possession and protecting body integrity
  // (replay-bounded by the drift window above). The verdict is screened against
  // the client's own Elliptic account but still signed with the proxy key, so
  // the path is gated by allowByok (an explicit operator trust decision).
  if (ellipticKey || ellipticSecret) {
    if (!config.allowByok) {
      return { error: "unauthorized", reason: "byok_disabled", partnerName };
    }
    if (!ellipticKey || !ellipticSecret) {
      return { error: "unauthorized", reason: "byok_incomplete", partnerName };
    }
    if (
      !verifySignature(
        ellipticSecret,
        accessSign,
        accessTimestamp,
        req.method,
        req.path,
        rawBody
      )
    ) {
      return {
        error: "unauthorized",
        reason: "invalid_signature",
        partnerName,
      };
    }
    const byokId =
      "byok:" +
      createHash("sha256").update(ellipticKey).digest("hex").slice(0, 16);
    return {
      partnerName: byokId,
      secret: ellipticSecret,
      byok: true,
      ellipticKey,
      ellipticSecret,
    };
  }

  if (!partnerName) {
    return { error: "unauthorized", reason: "missing_headers", partnerName };
  }
  return { error: "unauthorized", reason: "unknown_partner", partnerName };
}

export function computeHmacSignature(
  secretBase64: string,
  timestamp: string,
  method: string,
  path: string,
  body: string
): string {
  const hmac = createHmac("sha256", Buffer.from(secretBase64, "base64"));
  hmac.update(timestamp);
  hmac.update(method);
  hmac.update(path.toLowerCase());
  hmac.update(body);
  return hmac.digest("base64");
}

function firstValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

export function verifySignature(
  secretBase64: string,
  providedSignature: string,
  timestamp: string,
  method: string,
  path: string,
  body: string
): boolean {
  const expected = computeHmacSignature(
    secretBase64,
    timestamp,
    method,
    path,
    body
  );
  const expectedBuf = Buffer.from(expected, "base64");
  const providedBuf = Buffer.from(providedSignature, "base64");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
