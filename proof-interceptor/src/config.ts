// src/config.ts

import { z } from "zod";
import {
  DEFAULT_POLICY_TIMEOUT_MS,
  DEFAULT_POLICY_TTL_MS,
} from "./screening-policy.js";
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

/** An env var holding an integer, defaulted before parsing so an unset var and a bad one differ. */
function integerEnv(name: string, defaultValue: number) {
  return z
    .string()
    .default(String(defaultValue))
    .refine(
      (raw) => !Number.isNaN(parseInt(raw, 10)),
      `${name} must be a valid integer`
    )
    .transform((raw) => parseInt(raw, 10));
}

/** An env var that must carry a value; an empty one counts as unset, as it does in a shell. */
function requiredEnv(name: string) {
  const missing = `${name} env var is required`;
  return z
    .string({ required_error: missing, invalid_type_error: missing })
    .min(1, missing);
}

/** Any value but the literal `"true"` reads as false, so a typo disables rather than enables. */
const flagEnv = z
  .string()
  .optional()
  .transform((raw) => raw === "true");

const ServerEnvSchema = z
  .object({
    HOST: z.string().default("0.0.0.0"),
    PORT: integerEnv("PORT", 8080).refine(
      (port) => port >= 1 && port <= 65535,
      "PORT must be between 1 and 65535"
    ),
    MAX_BODY_BYTES: integerEnv("MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES).refine(
      (maxBodyBytes) => maxBodyBytes > 0,
      "MAX_BODY_BYTES must be a positive integer"
    ),
    TLS_CERT_PATH: z.string().optional(),
    TLS_KEY_PATH: z.string().optional(),
  })
  .refine(
    (env) => Boolean(env.TLS_CERT_PATH) === Boolean(env.TLS_KEY_PATH),
    "TLS_CERT_PATH and TLS_KEY_PATH must both be set or both absent"
  );

/**
 * Screening reads the pool's open-note policies over RPC and derives shadow account addresses
 * locally, so neither endpoint can be defaulted. Every value here is required as soon as screening
 * is on, which fails at startup rather than per transaction.
 */
const ScreeningEnvSchema = z.object({
  SCREENING_URL: requiredEnv("SCREENING_URL"),
  SCREENING_PARTNER_NAME: requiredEnv("SCREENING_PARTNER_NAME"),
  SCREENING_PARTNER_SECRET: requiredEnv("SCREENING_PARTNER_SECRET"),
  SCREENING_POOL_ADDRESS: requiredEnv("SCREENING_POOL_ADDRESS"),
  SCREENING_RPC_URL: requiredEnv("SCREENING_RPC_URL"),
  SCREENING_TIMEOUT_MS: integerEnv("SCREENING_TIMEOUT_MS", 10000),
  SCREENING_MAX_RETRIES: integerEnv("SCREENING_MAX_RETRIES", 2),
  SCREENING_TOTAL_TIMEOUT_MS: integerEnv("SCREENING_TOTAL_TIMEOUT_MS", 10000),
  SCREENING_POLICY_TTL_MS: integerEnv(
    "SCREENING_POLICY_TTL_MS",
    DEFAULT_POLICY_TTL_MS
  ),
  SCREENING_POLICY_TIMEOUT_MS: integerEnv(
    "SCREENING_POLICY_TIMEOUT_MS",
    DEFAULT_POLICY_TIMEOUT_MS
  ),
  SCREENING_FAIL_OPEN: flagEnv,
  SCREENING_BLOCK_NON_POOL_TX: flagEnv,
});

export function loadConfig(): Config {
  const server = parseEnv(ServerEnvSchema);

  const config: Config = {
    host: server.HOST,
    port: server.PORT,
    maxBodyBytes: server.MAX_BODY_BYTES,
  };

  if (process.env.SCREENING_URL) {
    const screening = parseEnv(ScreeningEnvSchema);
    config.screening = {
      ellipticProxyUrl: screening.SCREENING_URL,
      partnerName: screening.SCREENING_PARTNER_NAME,
      partnerSecret: screening.SCREENING_PARTNER_SECRET,
      timeoutMs: screening.SCREENING_TIMEOUT_MS,
      failOpen: screening.SCREENING_FAIL_OPEN,
      maxRetries: screening.SCREENING_MAX_RETRIES,
      totalTimeoutMs: screening.SCREENING_TOTAL_TIMEOUT_MS,
      poolAddress: screening.SCREENING_POOL_ADDRESS,
      rpcUrl: screening.SCREENING_RPC_URL,
      policyTtlMs: screening.SCREENING_POLICY_TTL_MS,
      policyTimeoutMs: screening.SCREENING_POLICY_TIMEOUT_MS,
      blockNonPoolTx: screening.SCREENING_BLOCK_NON_POOL_TX,
    };
  }

  if (server.TLS_CERT_PATH && server.TLS_KEY_PATH) {
    config.tls = {
      certPath: server.TLS_CERT_PATH,
      keyPath: server.TLS_KEY_PATH,
    };
  }

  return config;
}

/** Throws on the first complaint, so a misconfigured deployment names one fix at a time. */
function parseEnv<Schema extends z.ZodTypeAny>(
  schema: Schema
): z.infer<Schema> {
  const parsed = schema.safeParse(process.env);
  if (parsed.success) return parsed.data;
  throw new Error(parsed.error.issues[0].message);
}
