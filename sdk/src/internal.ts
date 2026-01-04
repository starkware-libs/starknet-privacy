import { BlockNumber } from "starknet";

// Import types only to avoid circular dependency (classes are defined here and re-exported from interfaces.ts)
import type { Blob, ChannelSerde, StarknetAddress, WitnessSerde } from "./interfaces.js";

/** Type guard for non-negative integers */
function isUint(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Assertion helper with type narrowing */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Base nonce class with shared logic and methods.
class Nonce {
  created?: BlockNumber;
  readonly slot: number;
  readonly sequence: number;

  protected constructor(slot: number, sequence: number, max: number, created?: BlockNumber) {
    assert(
      isUint(slot) && slot <= max,
      `Invalid nonce: slot must be a non-negative integer <= ${max}`
    );
    assert(isUint(sequence), "Invalid nonce: sequence must be a non-negative integer");
    this.slot = slot;
    this.sequence = sequence;
    this.created = created;
  }

  /** Returns a new instance of the same class with the sequence incremented by 1. */
  increment(): this {
    const Ctor = this.constructor as new (slot: number, sequence: number) => this;
    return new Ctor(this.slot, this.sequence + 1);
  }

  /**
   * Finds the nonce with the lowest `created` value (skipping those without one)
   * and returns its increment. Returns undefined if no nonces have `created`.
   */
  static next<T extends Nonce>(nonces: T[]): T | undefined {
    const withCreated = nonces.filter((n): n is T & { created: BlockNumber } => n.created != null);
    if (withCreated.length === 0) throw new Error("No nonces with created block number");

    const oldest = withCreated.reduce((min, n) => (n.created! < min.created! ? n : min));

    // TODO: add a check the oldest is old enough (at least 10 blocks old)

    return oldest.increment() as T;
  }
}

// Factory that creates a subclass of Nonce with a specific static MAX.
function withMax<TMax extends number>(max: TMax) {
  return class extends Nonce {
    static readonly MAX: TMax = max;

    constructor(slot: number, sequence: number) {
      super(slot, sequence, max);
    }
  };
}

export const ChannelNonce = withMax(10);
export const TokenNonce = withMax(100);

export type ChannelNonce = InstanceType<typeof ChannelNonce>;
export type TokenNonce = InstanceType<typeof TokenNonce>;

export { Nonce };

type ChannelKey = bigint;

/** Channel containing nonces for token and note creation. */
export class Channel {
  /** @internal */ readonly key: ChannelKey;
  /** @internal */ readonly nonces: ChannelNonce[];
  /** @internal */ readonly tokens: Map<StarknetAddress, TokenNonce[]>;

  constructor(key: ChannelKey, nonces: ChannelNonce[], tokens: Map<StarknetAddress, TokenNonce[]>) {
    this.key = key;
    this.nonces = nonces;
    this.tokens = tokens;
  }
}

export const channelSerde: ChannelSerde = {
  encode(channel) {
    const json = JSON.stringify({
      v: 1,
      key: channel.key.toString(),
      nonces: channel.nonces,
      tokens: Array.from(channel.tokens.entries()),
    });
    return json as Blob<string>;
  },
  decode(blob) {
    const parsed = JSON.parse(blob as string) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Invalid channel payload");
    }
    const { key, nonces, tokens } = parsed as Record<string, unknown>;
    const decodedKey = assertChannelKey(key);
    const decodedNonces = assertNonces(nonces);
    const decodedTokens = assertTokenEntries(tokens);

    return new Channel(decodedKey, decodedNonces, decodedTokens);
  },
};

/** Witness for a note, containing channel key and nonce. */
export class Witness {
  /** @internal */ readonly channelKey: ChannelKey;
  /** @internal */ readonly nonce: TokenNonce;

  constructor(channelKey: ChannelKey, nonce: TokenNonce) {
    this.channelKey = channelKey;
    this.nonce = nonce;
  }
}

export const witnessSerde: WitnessSerde = {
  encode(witness) {
    const json = JSON.stringify({
      v: 1,
      channelKey: witness.channelKey.toString(),
      nonce: witness.nonce,
    });
    return json as Blob<string>;
  },
  decode(blob) {
    const parsed = JSON.parse(blob as string) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Invalid witness payload");
    }
    const { channelKey, nonce } = parsed as Record<string, unknown>;
    const decodedChannelKey = assertChannelKey(channelKey);
    const decodedNonce = assertChannelNonce(nonce);

    return new Witness(decodedChannelKey, decodedNonce);
  },
};

function assertChannelKey(value: unknown): ChannelKey {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" || typeof value === "string") {
    return BigInt(value);
  }
  throw new Error("Invalid channel key");
}

function assertChannelNonce(value: unknown): ChannelNonce {
  if (value instanceof ChannelNonce) {
    return value;
  }
  assert(value !== null && typeof value === "object", "Invalid nonce: expected object");
  const { slot, sequence } = value as Record<string, unknown>;
  assert(
    isUint(slot) && isUint(sequence),
    "Invalid nonce: slot and sequence must be non-negative integers"
  );
  return new ChannelNonce(slot, sequence);
}

function assertTokenNonce(value: unknown): TokenNonce {
  if (value instanceof TokenNonce) {
    return value;
  }
  assert(value !== null && typeof value === "object", "Invalid nonce: expected object");
  const { slot, sequence } = value as Record<string, unknown>;
  assert(
    isUint(slot) && isUint(sequence),
    "Invalid nonce: slot and sequence must be non-negative integers"
  );
  return new TokenNonce(slot, sequence);
}

function assertNonces(value: unknown): ChannelNonce[] {
  if (Array.isArray(value)) {
    return value.map((n) => assertChannelNonce(n));
  }
  return [assertChannelNonce(value)];
}

function assertTokenEntries(value: unknown): Map<StarknetAddress, TokenNonce[]> {
  if (!Array.isArray(value)) {
    throw new Error("Invalid tokens");
  }
  const entries: [StarknetAddress, TokenNonce[]][] = value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error("Invalid token entry");
    }
    const [token, nonces] = entry;
    const normalized = Array.isArray(nonces) ? nonces : [nonces];
    const decodedNonces = normalized.map((n) => assertTokenNonce(n));
    return [token as StarknetAddress, decodedNonces];
  });
  return new Map(entries);
}
