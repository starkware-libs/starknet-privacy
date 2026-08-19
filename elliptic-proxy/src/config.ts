// src/config.ts
import { isHexFelt } from "./felt.js";

// Each partner carries its own Elliptic credentials: the proxy re-signs that
// partner's upstream calls with the partner's own key + secret, so usage and
// revocation are isolated per partner.
export interface PartnerCredentials {
  // Partner's HMAC auth secret (base64) — verifies the inbound x-access-sign.
  hmacSecret: string;
  // Partner's own Elliptic API key, sent as x-access-key to Elliptic.
  ellipticKey: string;
  // Partner's own Elliptic HMAC secret (base64), used to sign the upstream call.
  ellipticSecret: string;
}

export interface Config {
  elliptic: {
    url: string;
    timeoutMs: number;
  };
  rateLimitPerMinute: number;
  maxBodyBytes: number;
  configCacheTtlSeconds: number;
  blockedCacheTtlSeconds: number;
  partners: Record<string, PartnerCredentials>; // partner name -> credentials
  // Operator deny list (hex felts): always blocked, in every mode — covers
  // upstream false negatives.
  additionalBlockedAddresses?: string[];
  // Operator allow list (hex felts): always allowed, winning over the deny
  // list, the cache, and the upstream — rescues upstream false positives.
  blockOverrideAddresses?: string[];
  // STARK-curve private key (felt hex, 1 <= key < curve order) used to sign
  // screening attestations. Managed by the FPI cloud function in production.
  signingPrivateKey: string;
  // chain_id felt (hex) of the network the deployment signs for, bound into
  // the SNIP-12 domain; must match what the contract derives from get_tx_info.
  // SN_MAIN must never be combined with a mock elliptic.url — config load
  // rejects it.
  chainId: string;
  // When true, clients may screen without being a registered partner by
  // supplying their own Elliptic key + secret (BYOK). Such verdicts are still
  // signed with this deployment's signingPrivateKey, so the attestation is
  // pool-trusted exactly like a partner's — enable deliberately. Defaults
  // false (opt-in per deployment).
  allowByok: boolean;
}

// 'SN_MAIN' as a Cairo short string: the felt is the big-endian ASCII bytes.
const SN_MAIN_CHAIN_ID = BigInt("0x" + Buffer.from("SN_MAIN").toString("hex"));

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
  const parsedPartners: Record<string, PartnerCredentials> = {};
  for (const [name, value] of Object.entries(partners)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`config: partners.${name} must be a non-null object`);
    }
    const entry = value as Record<string, unknown>;
    const requirePartnerField = (field: string): string => {
      const fieldValue = entry[field];
      if (typeof fieldValue !== "string" || fieldValue.length === 0) {
        throw new Error(
          `config: partners.${name}.${field} must be a non-empty string`
        );
      }
      return fieldValue;
    };
    parsedPartners[name] = {
      hmacSecret: requirePartnerField("hmacSecret"),
      ellipticKey: requirePartnerField("ellipticKey"),
      ellipticSecret: requirePartnerField("ellipticSecret"),
    };
  }

  const ellipticUrl = requireString(elliptic, "url");
  const chainId = requireString(root, "chainId").toLowerCase();
  if (!isHexFelt(chainId)) {
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
      timeoutMs: requirePositiveNumber(elliptic, "timeoutMs"),
    },
    rateLimitPerMinute: requirePositiveNumber(root, "rateLimitPerMinute"),
    maxBodyBytes: requirePositiveNumber(root, "maxBodyBytes"),
    configCacheTtlSeconds: requirePositiveNumber(root, "configCacheTtlSeconds"),
    blockedCacheTtlSeconds: requirePositiveNumber(
      root,
      "blockedCacheTtlSeconds"
    ),
    partners: parsedPartners,
    additionalBlockedAddresses: parseLowercaseHexList(
      root,
      "additionalBlockedAddresses"
    ),
    blockOverrideAddresses: parseLowercaseHexList(
      root,
      "blockOverrideAddresses"
    ),
    signingPrivateKey: requireString(root, "signingPrivateKey"),
    chainId,
    // Only the literal `true` enables BYOK; absent/any other value is false, so
    // the path stays off unless a deployment opts in explicitly (fail closed).
    allowByok: root.allowByok === true,
  };
}

// Operational warning on every fresh config load (cold start and each TTL
// refresh): a mock deployment must be unmistakable in the logs.
function warnOnMockPolicy(config: Config): void {
  if (isMockEllipticUrl(config.elliptic.url)) {
    console.warn(
      JSON.stringify({
        warning: "mock_mode",
        ellipticUrl: config.elliptic.url,
        message: "mock Elliptic upstream: verdicts are not real screening",
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
    if (!isHexFelt(entry)) {
      throw new Error(`config: ${key} entries must be 0x-prefixed hex felts`);
    }
    return entry.toLowerCase();
  });
}
