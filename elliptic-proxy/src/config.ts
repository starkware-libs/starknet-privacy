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
  // Test-only deny list consumed by the mock Elliptic upstream ("mock:"
  // elliptic.url): listed addresses screen as sanctioned. Ignored (with a
  // load-time warning) when screening live — a live verdict must come from
  // Elliptic.
  additionalBlockedAddresses?: string[];
  // STARK-curve private key (felt hex, 1 <= key < curve order) used to sign
  // screening attestations. Managed by the FPI cloud function in production.
  signingPrivateKey: string;
  // chain_id felt (hex) of the network the deployment signs for, bound into
  // the SNIP-12 domain; must match what the contract derives from get_tx_info.
  // SN_MAIN must never be combined with a mock elliptic.url — config load
  // rejects it.
  chainId: string;
}

export const HEX_FELT = /^0x[0-9a-fA-F]+$/;

// 'SN_MAIN' as a Cairo short string.
const SN_MAIN_CHAIN_ID = 0x534e5f4d41494en;

// A "mock:" elliptic.url selects the in-process mock Elliptic upstream (see
// mock-elliptic.ts) instead of the live API.
export function isMockEllipticUrl(url: string): boolean {
  return url.startsWith("mock:");
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
    warnOnMockPolicy(config);
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

  const ellipticUrl = requireString(elliptic, "url");
  const chainId = requireString(root, "chainId").toLowerCase();
  if (!HEX_FELT.test(chainId)) {
    throw new Error("config: chainId must be a 0x-prefixed hex felt");
  }
  // A mock upstream must never screen for mainnet: it would produce real
  // verdicts with no real screening behind them.
  if (isMockEllipticUrl(ellipticUrl) && BigInt(chainId) === SN_MAIN_CHAIN_ID) {
    throw new Error(
      "config: a mock elliptic.url is not allowed with the SN_MAIN chainId"
    );
  }

  return {
    elliptic: {
      url: ellipticUrl,
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
    additionalBlockedAddresses: parseLowercaseHexList(
      root,
      "additionalBlockedAddresses"
    ),
    signingPrivateKey: requireString(root, "signingPrivateKey"),
    chainId,
  };
}

// Operational warnings on every fresh config load (cold start and each TTL
// refresh): a mock deployment must be unmistakable in the logs, and a deny
// list outside mock screening is dead config (it is test-only and ignored).
function warnOnMockPolicy(config: Config): void {
  if (isMockEllipticUrl(config.elliptic.url)) {
    console.warn(
      JSON.stringify({
        warning: "mock_mode",
        ellipticUrl: config.elliptic.url,
        message: "mock Elliptic upstream: verdicts are not real screening",
      })
    );
  } else if (config.additionalBlockedAddresses?.length) {
    console.warn(
      JSON.stringify({
        warning: "blocklist_ignored",
        message:
          "additionalBlockedAddresses is test-only and ignored when screening live",
      })
    );
  }
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
  // Entries are felts (addresses). Validate the format at load so a malformed
  // entry fails fast instead of silently never matching.
  return (value as string[]).map((entry) => {
    if (!HEX_FELT.test(entry)) {
      throw new Error(`config: ${key} entries must be 0x-prefixed hex felts`);
    }
    return entry.toLowerCase();
  });
}
