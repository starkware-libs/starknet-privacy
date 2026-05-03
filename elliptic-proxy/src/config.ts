// src/config.ts

export interface Config {
  elliptic: {
    url: string;
    key: string;
    secret: string;
    timeoutMs: number;
  };
  rateLimitPerMinute: number;
  maxBodyBytes: number;
  configCacheTtlSeconds: number;
  blockedCacheTtlSeconds: number;
  partners: Record<string, string>; // partner name -> HMAC secret
  // When true, the proxy never calls Elliptic. Use on non-mainnet
  // deployments where Elliptic has no data coverage, or as a kill
  // switch. Off by default. Operator-curated lists below still apply.
  skipElliptic?: boolean;
  // Lowercase hex addresses to always treat as blocked, regardless of
  // Elliptic's verdict (or in lieu of it when skipElliptic is set).
  // Supplemental deny list for operator policy.
  additionalBlockedAddresses?: string[];
  // Lowercase hex addresses to always treat as allowed, regardless of
  // Elliptic's verdict and regardless of additionalBlockedAddresses.
  // Operator override for addresses we believe were wrongly flagged.
  blockOverrideAddresses?: string[];
}

type SecretFetcher = () => Promise<string>;

export class ConfigLoader {
  private cached: Config | null = null;
  private cachedAt = 0;
  private ttlMs = 0;

  constructor(
    private readonly fetcher: SecretFetcher,
    private readonly defaultTtlMs = 300_000
  ) {}

  async get(): Promise<Config> {
    if (this.cached && Date.now() - this.cachedAt < this.ttlMs) {
      return this.cached;
    }

    const raw = JSON.parse(await this.fetcher());
    const config = validateConfig(raw);
    this.ttlMs =
      config.configCacheTtlSeconds != null
        ? config.configCacheTtlSeconds * 1000
        : this.defaultTtlMs;
    this.cachedAt = Date.now();
    this.cached = config;

    return config;
  }
}

function requireString(object: Record<string, unknown>, path: string): string {
  const value = object[path];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`config: ${path} must be a non-empty string`);
  }
  return value;
}

function requireNumber(object: Record<string, unknown>, path: string): number {
  const value = object[path];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`config: ${path} must be a finite number`);
  }
  return value;
}

function requirePositiveNumber(
  object: Record<string, unknown>,
  path: string
): number {
  const value = requireNumber(object, path);
  if (value <= 0) {
    throw new Error(`config: ${path} must be a positive number`);
  }
  return value;
}

function validateConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("config: must be a non-null object");
  }
  const root = raw as Record<string, unknown>;

  if (
    typeof root.elliptic !== "object" ||
    root.elliptic === null ||
    Array.isArray(root.elliptic)
  ) {
    throw new Error("config: elliptic must be a non-null object");
  }
  const elliptic = root.elliptic as Record<string, unknown>;

  if (
    typeof root.partners !== "object" ||
    root.partners === null ||
    Array.isArray(root.partners)
  ) {
    throw new Error("config: partners must be a non-null object");
  }
  const partners = root.partners as Record<string, unknown>;
  for (const [name, secret] of Object.entries(partners)) {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new Error(`config: partners.${name} must be a non-empty string`);
    }
  }

  let skipElliptic: boolean | undefined;
  if (root.skipElliptic !== undefined) {
    if (typeof root.skipElliptic !== "boolean") {
      throw new Error("config: skipElliptic must be a boolean");
    }
    skipElliptic = root.skipElliptic;
  }

  return {
    elliptic: {
      url: requireString(elliptic, "url"),
      key: requireString(elliptic, "key"),
      secret: requireString(elliptic, "secret"),
      timeoutMs: requirePositiveNumber(elliptic, "timeoutMs"),
    },
    rateLimitPerMinute: requirePositiveNumber(root, "rateLimitPerMinute"),
    maxBodyBytes: requirePositiveNumber(root, "maxBodyBytes"),
    configCacheTtlSeconds: requirePositiveNumber(root, "configCacheTtlSeconds"),
    blockedCacheTtlSeconds: requirePositiveNumber(
      root,
      "blockedCacheTtlSeconds"
    ),
    partners: root.partners as Record<string, string>,
    skipElliptic,
    additionalBlockedAddresses: parseLowercaseHexList(
      root,
      "additionalBlockedAddresses"
    ),
    blockOverrideAddresses: parseLowercaseHexList(
      root,
      "blockOverrideAddresses"
    ),
  };
}

function parseLowercaseHexList(
  object: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((a) => typeof a === "string")) {
    throw new Error(`config: ${key} must be string[]`);
  }
  return (value as string[]).map((a) => a.toLowerCase());
}
