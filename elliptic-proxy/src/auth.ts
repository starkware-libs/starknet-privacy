// src/auth.ts
import { createHmac, timingSafeEqual } from "crypto";
import type { Request } from "@google-cloud/functions-framework";
import type { Config } from "./config.js";

const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

export interface AuthResult {
  partnerName: string;
  secret: string;
}

export function authenticateRequest(
  req: Request,
  config: Config
): AuthResult | { error: string; reason: string; partnerName?: string } {
  const partnerName = firstValue(req.headers["x-access-key"]);
  const accessSign = firstValue(req.headers["x-access-sign"]);
  const accessTimestamp = firstValue(req.headers["x-access-timestamp"]);

  if (!partnerName || !accessSign || !accessTimestamp) {
    return { error: "unauthorized", reason: "missing_headers", partnerName };
  }

  const timestampMs = Number(accessTimestamp);
  if (
    Number.isNaN(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > MAX_TIMESTAMP_DRIFT_MS
  ) {
    return { error: "unauthorized", reason: "timestamp_expired", partnerName };
  }

  if (!Object.hasOwn(config.partners, partnerName)) {
    return { error: "unauthorized", reason: "unknown_partner", partnerName };
  }

  const partnerSecret = config.partners[partnerName];
  if (!partnerSecret) {
    return { error: "unauthorized", reason: "unknown_partner", partnerName };
  }

  const rawBody = req.rawBody?.toString() ?? "";
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
