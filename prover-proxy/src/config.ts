// src/config.ts

export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

export interface Config {
  upstreamUrl: string;
  host: string;
  port: number;
  forwardUnknownMethods: boolean;
  maxBodyBytes: number;
  tls?: {
    certPath: string;
    keyPath: string;
  };
}

export function loadConfig(): Config {
  const port = parseInt(process.env.PORT ?? "8080", 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const maxBodyBytes = parseInt(
    process.env.MAX_BODY_BYTES ?? String(DEFAULT_MAX_BODY_BYTES),
    10
  );
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("MAX_BODY_BYTES must be a positive integer");
  }

  const config: Config = {
    upstreamUrl: requiredEnv("UPSTREAM_URL"),
    host: process.env.HOST ?? "0.0.0.0",
    port,
    forwardUnknownMethods: process.env.FORWARD_UNKNOWN_METHODS === "true",
    maxBodyBytes,
  };

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
