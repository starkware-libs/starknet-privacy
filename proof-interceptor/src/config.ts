// src/config.ts

import type { ScreeningConfig } from "./screening-interceptor.js";

export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

export interface Config {
  host: string;
  port: number;
  maxBodyBytes: number;
  screening?: ScreeningConfig;
  tls?: {
    certPath: string;
    keyPath: string;
  };
}

export function loadConfig(): Config {
  const port = parseIntEnv("PORT", 8080);
  if (port < 1 || port > 65535) {
    throw new Error("PORT must be between 1 and 65535");
  }
  const maxBodyBytes = parseIntEnv("MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES);
  if (maxBodyBytes <= 0) {
    throw new Error("MAX_BODY_BYTES must be a positive integer");
  }

  const config: Config = {
    host: process.env.HOST ?? "0.0.0.0",
    port,
    maxBodyBytes,
  };

  const screeningUrl = process.env.SCREENING_URL;
  if (screeningUrl) {
    config.screening = {
      ellipticProxyUrl: screeningUrl,
      partnerName: requiredEnv("SCREENING_PARTNER_NAME"),
      partnerSecret: requiredEnv("SCREENING_PARTNER_SECRET"),
      timeoutMs: parseIntEnv("SCREENING_TIMEOUT_MS", 10000),
      failOpen: process.env.SCREENING_FAIL_OPEN === "true",
      maxRetries: parseIntEnv("SCREENING_MAX_RETRIES", 2),
      totalTimeoutMs: parseIntEnv("SCREENING_TOTAL_TIMEOUT_MS", 10000),
      poolAddress: requiredEnv("SCREENING_POOL_ADDRESS"),
      blockNonPoolTx: process.env.SCREENING_BLOCK_NON_POOL_TX === "true",
      healthMaxUnavailableMs: parseIntEnv(
        "SCREENING_HEALTH_MAX_UNAVAILABLE_MS",
        30000
      ),
    };
  }

  const certPath = process.env.TLS_CERT_PATH;
  const keyPath = process.env.TLS_KEY_PATH;
  if (certPath && keyPath) {
    config.tls = { certPath, keyPath };
  } else if (certPath || keyPath) {
    throw new Error(
      "TLS_CERT_PATH and TLS_KEY_PATH must both be set or both absent"
    );
  }

  return config;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} env var is required`);
  return value;
}

/**
 * Returns a copy of `config` suitable for logging at startup. Strips fields
 * that could leak credentials — currently `screening.partnerSecret`. The
 * presence of the secret is preserved as a marker so misconfiguration (e.g.
 * empty secret in production) is still observable from logs.
 */
export function redactConfig(config: Config): Record<string, unknown> {
  const { screening, tls, ...rest } = config;
  const redacted: Record<string, unknown> = { ...rest };
  if (screening) {
    const { partnerSecret, ...screeningRest } = screening;
    redacted.screening = {
      ...screeningRest,
      partnerSecret: partnerSecret.length > 0 ? "[REDACTED]" : "[EMPTY]",
    };
  }
  if (tls) {
    // Paths are not secrets but the contents are; surface only the on/off bit
    // so startup logs stay narrow.
    redacted.tls = { enabled: true };
  }
  return redacted;
}

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be a valid integer`);
  return parsed;
}
