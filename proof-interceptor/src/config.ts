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

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be a valid integer`);
  return parsed;
}
