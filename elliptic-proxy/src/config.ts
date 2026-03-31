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
  partners: Record<string, string>; // partner name -> HMAC secret
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
  if (typeof raw !== "object" || raw === null) {
    throw new Error("config: must be a non-null object");
  }
  const root = raw as Record<string, unknown>;

  if (typeof root.elliptic !== "object" || root.elliptic === null) {
    throw new Error("config: elliptic must be a non-null object");
  }
  const elliptic = root.elliptic as Record<string, unknown>;

  if (typeof root.partners !== "object" || root.partners === null) {
    throw new Error("config: partners must be a non-null object");
  }
  const partners = root.partners as Record<string, unknown>;
  for (const [name, secret] of Object.entries(partners)) {
    if (typeof secret !== "string" || secret.length === 0) {
      throw new Error(`config: partners.${name} must be a non-empty string`);
    }
  }

  return {
    elliptic: {
      url: requireString(elliptic, "url"),
      key: requireString(elliptic, "key"),
      secret: requireString(elliptic, "secret"),
      timeoutMs: requireNumber(elliptic, "timeoutMs"),
    },
    rateLimitPerMinute: requirePositiveNumber(root, "rateLimitPerMinute"),
    maxBodyBytes: requireNumber(root, "maxBodyBytes"),
    configCacheTtlSeconds: requireNumber(root, "configCacheTtlSeconds"),
    partners: root.partners as Record<string, string>,
  };
}
