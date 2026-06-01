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
  // Screening v2 signing. Present only on deployments that serve POST /sign.
  // The /screen path ignores it entirely.
  signing?: {
    // STARK-curve private key (felt hex, 1 <= key < curve order) used to sign
    // screening attestations. Managed by the FPI cloud function in production.
    privateKey: string;
    // Optional allowlist of chain_id felts (lowercase hex) the signer will
    // sign for. When set, /sign rejects any other chain_id with 400.
    allowedChainIds?: string[];
  };
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

  let signing: Config["signing"];
  if (root.signing !== undefined) {
    if (
      typeof root.signing !== "object" ||
      root.signing === null ||
      Array.isArray(root.signing)
    ) {
      throw new Error("config: signing must be a non-null object");
    }
    const signingRaw = root.signing as Record<string, unknown>;
    signing = {
      privateKey: requireString(signingRaw, "privateKey"),
      allowedChainIds: parseLowercaseHexList(signingRaw, "allowedChainIds"),
    };
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
    signing,
  };
}

function parseLowercaseHexList(
  object: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`config: ${key} must be string[]`);
  }
  // Entries are felts (addresses / chain ids). Validate the format at load so
  // the /sign path can compare them numerically (BigInt) without guarding, and
  // so a malformed entry fails fast instead of silently never matching.
  const HEX_FELT = /^0x[0-9a-fA-F]+$/;
  return (value as string[]).map((entry) => {
    if (!HEX_FELT.test(entry)) {
      throw new Error(`config: ${key} entries must be 0x-prefixed hex felts`);
    }
    return entry.toLowerCase();
  });
}
