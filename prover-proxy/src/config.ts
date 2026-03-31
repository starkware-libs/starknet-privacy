// src/config.ts

export interface Config {
  upstreamUrl: string;
  host: string;
  port: number;
  maxBodyBytes: number;
  tls?: {
    certPath: string;
    keyPath: string;
  };
}

export function loadConfig(): Config {
  const config: Config = {
    upstreamUrl: requiredEnv("UPSTREAM_URL"),
    host: process.env.HOST ?? "0.0.0.0",
    port: parseInt(process.env.PORT ?? "8080", 10),
    maxBodyBytes: parseInt(
      process.env.MAX_BODY_BYTES ?? String(5 * 1024 * 1024),
      10
    ),
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
