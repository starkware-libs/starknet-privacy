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
   * Increments the nonce array in-place. Finds the nonce with the lowest `created`
   * value (skipping those without one) and replaces it with an incremented version.
   * If no nonces have `created` and there's room for a new slot, appends a new nonce.
   *
   * @param nonces - Array of nonces, assumed to have slots incrementing by 1
   * @param maxSlots - Maximum number of slots allowed
   * @param Ctor - Constructor for creating new nonces
   * @returns The index of the changed nonce and the previous value (undefined if new slot)
   */
  protected static _increment<T extends Nonce>(
    nonces: T[],
    maxSlots: number,
    Ctor: new (slot: number, sequence: number) => T
  ): { index: number; previous: T | undefined } {
    // Verify slots increment by 1
    for (let i = 0; i < nonces.length; i++) {
      assert(
        nonces[i].slot === i,
        `Invalid nonce array: expected slot ${i}, got ${nonces[i].slot}`
      );
    }

    const withCreated = nonces.filter((n): n is T & { created: BlockNumber } => n.created != null);

    if (withCreated.length === 0) {
      // No nonces have been created yet - add a new slot if room available
      assert(nonces.length < maxSlots, `Cannot add new slot: already at max slots (${maxSlots})`);
      const index = nonces.length;
      nonces.push(new Ctor(index, 0));
      return { index, previous: undefined };
    }

    const oldest = withCreated.reduce((min, n) => (n.created! < min.created! ? n : min));
    const index = oldest.slot;
    const previous = nonces[index];

    // TODO: add a check the oldest is old enough (at least 10 blocks old)

    nonces[index] = oldest.increment() as T;
    return { index, previous };
  }
}

export class TokenNonce extends Nonce {
  static readonly MAX_SLOTS = 10;

  constructor(slot: number, sequence: number, created?: BlockNumber) {
    super(slot, sequence, TokenNonce.MAX_SLOTS, created);
  }

  /** Increments the nonce array in-place, returns the changed index and previous value. */
  static increment(nonces: TokenNonce[]): { index: number; previous: TokenNonce | undefined } {
    return Nonce._increment(nonces, TokenNonce.MAX_SLOTS, TokenNonce);
  }
}

export class NoteNonce extends Nonce {
  static readonly MAX_SLOTS = 100;

  constructor(slot: number, sequence: number, created?: BlockNumber) {
    super(slot, sequence, NoteNonce.MAX_SLOTS, created);
  }

  /** Increments the nonce array in-place, returns the changed index and previous value. */
  static increment(nonces: NoteNonce[]): { index: number; previous: NoteNonce | undefined } {
    return Nonce._increment(nonces, NoteNonce.MAX_SLOTS, NoteNonce);
  }
}

type ChannelKey = bigint;

/** Channel containing nonces for token and note creation. */
export class Channel {
  /** @internal */ readonly key: ChannelKey;
  /** @internal */ readonly nonces: TokenNonce[];
  /** @internal */ readonly tokens: Map<StarknetAddress, NoteNonce[]>;

  constructor(key: ChannelKey, nonces: TokenNonce[], tokens: Map<StarknetAddress, NoteNonce[]>) {
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
  /** @internal */ readonly nonce: NoteNonce;

  constructor(channelKey: ChannelKey, nonce: NoteNonce) {
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

function assertChannelNonce(value: unknown): TokenNonce {
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

function assertTokenNonce(value: unknown): NoteNonce {
  if (value instanceof NoteNonce) {
    return value;
  }
  assert(value !== null && typeof value === "object", "Invalid nonce: expected object");
  const { slot, sequence } = value as Record<string, unknown>;
  assert(
    isUint(slot) && isUint(sequence),
    "Invalid nonce: slot and sequence must be non-negative integers"
  );
  return new NoteNonce(slot, sequence);
}

function assertNonces(value: unknown): TokenNonce[] {
  if (Array.isArray(value)) {
    return value.map((n) => assertChannelNonce(n));
  }
  return [assertChannelNonce(value)];
}

function assertTokenEntries(value: unknown): Map<StarknetAddress, NoteNonce[]> {
  if (!Array.isArray(value)) {
    throw new Error("Invalid tokens");
  }
  const entries: [StarknetAddress, NoteNonce[]][] = value.map((entry) => {
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
