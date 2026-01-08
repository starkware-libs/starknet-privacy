import { BlockNumber } from "starknet";

// Import types only to avoid circular dependency (classes are defined here and re-exported from interfaces.ts)
import type { Blob, ChannelSerde, StarknetAddress, WitnessSerde } from "../interfaces.js";
import { AddressMap } from "../utils/maps.js";
import { jsonStringify, jsonParse } from "../utils/json.js";

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
  readonly sequence: number;

  protected constructor(sequence: number, created?: BlockNumber) {
    assert(isUint(sequence), "Invalid nonce: sequence must be a non-negative integer");
    this.sequence = sequence;
    this.created = created;
  }

  /** Returns a new instance of the same class with the sequence incremented by 1. */
  increment(): this {
    const Ctor = this.constructor as new (sequence: number) => this;
    return new Ctor(this.sequence + 1);
  }

  decrement(): this {
    assert(this.sequence > 0, "Invalid nonce: cannot decrement below 0");
    const Ctor = this.constructor as new (sequence: number) => this;
    return new Ctor(this.sequence - 1);
  }
}

export class TokenNonce extends Nonce {
  constructor(sequence: number = 0, created?: BlockNumber) {
    super(sequence, created);
  }
}

export class NoteNonce extends Nonce {
  constructor(sequence: number = 0, created?: BlockNumber) {
    super(sequence, created);
  }
}

type ChannelKey = bigint;

/** Channel containing nonces for token and note creation. */
export class Channel {
  /** @internal */ readonly key: ChannelKey;
  /** @internal */ tokenNonce: TokenNonce;
  /** @internal */ readonly tokens: AddressMap<NoteNonce>;

  constructor(
    key: ChannelKey,
    tokenNonce?: TokenNonce,
    tokens?: Iterable<[StarknetAddress, NoteNonce]>
  ) {
    this.key = key;
    this.tokenNonce = tokenNonce ?? new TokenNonce();
    this.tokens = new AddressMap<NoteNonce>(() => new NoteNonce());
    if (tokens) {
      for (const [k, v] of tokens) {
        this.tokens.set(k, v);
      }
    }
  }

  incrementTokenNonce(): TokenNonce {
    const current = this.tokenNonce;
    this.tokenNonce = current.increment();
    return current;
  }

  incrementNoteNonce(token: StarknetAddress): NoteNonce {
    const current = this.tokens.get(token)!;
    this.tokens.set(token, current.increment());
    return current;
  }
}

export const channelSerde: ChannelSerde = {
  encode(channel) {
    // jsonStringify handles bigint keys automatically
    const json = jsonStringify({
      v: 1,
      key: channel.key,
      tokenNonce: channel.tokenNonce,
      tokens: Array.from(channel.tokens.entries()),
    });
    return json as Blob<string>;
  },
  decode(blob) {
    // jsonParse restores bigints automatically
    const parsed = jsonParse(blob as string);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Invalid channel payload");
    }
    const { key, tokenNonce, tokens } = parsed as Record<string, unknown>;
    const decodedKey = assertChannelKey(key);
    const decodedTokenNonce = assertTokenNonce(tokenNonce);
    const decodedTokens = assertTokenEntries(tokens);

    return new Channel(decodedKey, decodedTokenNonce, decodedTokens);
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
    const json = jsonStringify({
      v: 1,
      channelKey: witness.channelKey,
      nonce: witness.nonce,
    });
    return json as Blob<string>;
  },
  decode(blob) {
    const parsed = jsonParse(blob as string);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Invalid witness payload");
    }
    const { channelKey, nonce } = parsed as Record<string, unknown>;
    const decodedChannelKey = assertChannelKey(channelKey);
    const decodedNonce = assertNoteNonce(nonce);

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

function assertTokenNonce(value: unknown): TokenNonce {
  if (value instanceof TokenNonce) {
    return value;
  }
  assert(value !== null && typeof value === "object", "Invalid nonce: expected object");
  const { sequence } = value as Record<string, unknown>;
  assert(isUint(sequence), "Invalid nonce: sequence must be a non-negative integer");
  return new TokenNonce(sequence);
}

function assertNoteNonce(value: unknown): NoteNonce {
  if (value instanceof NoteNonce) {
    return value;
  }
  assert(value !== null && typeof value === "object", "Invalid nonce: expected object");
  const { sequence } = value as Record<string, unknown>;
  assert(isUint(sequence), "Invalid nonce: sequence must be a non-negative integer");
  return new NoteNonce(sequence);
}

function assertTokenEntries(value: unknown): Map<StarknetAddress, NoteNonce> {
  if (!Array.isArray(value)) {
    throw new Error("Invalid tokens");
  }
  const entries: [StarknetAddress, NoteNonce][] = value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error("Invalid token entry");
    }
    const [token, nonce] = entry;
    return [token as StarknetAddress, assertNoteNonce(nonce)];
  });
  return new Map(entries);
}
