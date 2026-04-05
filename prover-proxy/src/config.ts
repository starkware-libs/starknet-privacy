// src/config.ts

import type { ScreeningConfig } from "./screening-interceptor.js";

export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

export interface Config {
  upstreamUrl: string;
  host: string;
  port: number;
  forwardUnknownMethods: boolean;
  maxBodyBytes: number;
  screening?: ScreeningConfig;
  tls?: {
    certPath: string;
    keyPath: string;
  };
}

export function loadConfig(): Config {
  const port = parseIntEnv("PORT", 8080);
  const maxBodyBytes = parseIntEnv("MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES);

  const config: Config = {
    upstreamUrl: requiredEnv("UPSTREAM_URL"),
    host: process.env.HOST ?? "0.0.0.0",
    port,
    forwardUnknownMethods: process.env.FORWARD_UNKNOWN_METHODS === "true",
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} env var is required`);
  return value;
}

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be a valid integer`);
  return parsed;
}
