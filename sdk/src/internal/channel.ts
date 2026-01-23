import { BlockIdentifier, BlockNumber } from "starknet";
import {
  SetupRequirement,
  StarknetAddressBigint,
  type Blob,
  type ChannelSerde,
  type StarknetAddress,
  type WitnessSerde,
} from "../interfaces.js";
import { AddressMap } from "../utils/maps.js";
import { jsonStringify, jsonParse } from "../utils/json.js";
import { PublicKey } from "../utils/crypto.js";

/** Type guard for non-negative integers */
function isUint(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Assertion helper with type narrowing */
function assert(condition: unknown, message: () => string): asserts condition {
  if (!condition) throw new Error(message());
}

export type IncomingChannelCursor = {
  /** @internal */ channelKey: ChannelKey;
  /** @internal */ subchannelKeyIndex: number;
  /** @internal */ noteIndexes: AddressMap<number>; // token -> i
};

export type NotesCursor = {
  /* when was this cursor valid */
  /** @internal */ blockId: BlockIdentifier;
  /* the number of channels opened */
  /** @internal */ incomingChannelsCount: number;
  /* per sender, a cursor to the subcahnels they opened and notes they created */
  /** @internal */ incomingChannels: AddressMap<IncomingChannelCursor>; // sender -> cursor
};

// Base nonce class with shared logic and methods.
class Nonce {
  created?: BlockNumber;
  readonly sequence: number;

  protected constructor(sequence: number, created?: BlockNumber) {
    assert(isUint(sequence), () => "Invalid nonce: sequence must be a non-negative integer");
    this.sequence = sequence;
    this.created = created;
  }

  /** Returns a new instance of the same class with the sequence incremented by 1. */
  increment(): this {
    const Ctor = this.constructor as new (sequence: number) => this;
    return new Ctor(this.sequence + 1);
  }

  decrement(): this {
    assert(this.sequence > 0, () => "Invalid nonce: cannot decrement below 0");
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
  /** @internal */ readonly publicKey: PublicKey;
  /** @internal */ key?: ChannelKey;
  /** @internal */ readonly tokens: AddressMap<{ tokenNonce: number; noteNonce: number }>; // for the next note for each token

  constructor(
    publicKey: PublicKey,
    key?: ChannelKey,
    tokens?: Iterable<[StarknetAddress, { tokenNonce: number; noteNonce: number }]>
  ) {
    this.publicKey = publicKey;
    this.key = key;
    this.tokens = new AddressMap<{
      tokenNonce: number;
      noteNonce: number;
    }>(() => {
      return { tokenNonce: 0, noteNonce: 0 };
    });
    if (tokens) {
      for (const [k, v] of tokens) {
        this.tokens.set(k, v);
      }
    }
  }

  incrementNoteNonce(token: StarknetAddress): number {
    const current = this.tokens.get(token)!;
    current.noteNonce += 1;
    this.tokens.set(token, current);
    return current.noteNonce;
  }

  /** Create a deep clone of this channel */
  clone(): Channel {
    return new Channel(this.publicKey, this.key, this.tokens.entries());
  }

  toSetupRequirement(token: StarknetAddressBigint): SetupRequirement {
    if (!this.publicKey) {
      return SetupRequirement.Register;
    }
    if (!this.key) {
      return SetupRequirement.SetupChannel;
    }
    if (!this.tokens.has(token)) {
      return SetupRequirement.SetupToken;
    }
    return SetupRequirement.Ready;
  }
}

export const channelSerde: ChannelSerde = {
  encode(channel) {
    // jsonStringify handles bigint keys automatically
    const json = jsonStringify({
      v: 1,
      key: channel.key,
      recipientPublicKey: channel.publicKey,
      tokens: Array.from(channel.tokens.entries()).map(([k, v]) => [
        k,
        {
          tokenNonce: { sequence: v.tokenNonce },
          noteNonce: { sequence: v.noteNonce },
        },
      ]),
    });
    return json as Blob<string>;
  },
  decode(blob) {
    // jsonParse restores bigints automatically
    const parsed = jsonParse(blob as string);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Invalid channel payload");
    }
    const { key, recipientPublicKey, tokens } = parsed as Record<string, unknown>;
    const decodedKey = assertChannelKey(key);
    const decodedPublicKey = assertChannelKey(recipientPublicKey); // same format as key
    const decodedTokens = assertTokenEntries(tokens);

    return new Channel(decodedPublicKey, decodedKey, decodedTokens);
  },
};

/** Witness for a note, containing channel key and nonce. */
export class Witness {
  /** @internal */ readonly channelKey: ChannelKey;
  /** @internal */ readonly nonce: number;
  /** @internal */ readonly r: bigint;

  constructor(channelKey: ChannelKey, nonce: number, r: bigint) {
    this.channelKey = channelKey;
    this.nonce = nonce;
    this.r = r;
  }
}

export const witnessSerde: WitnessSerde = {
  encode(witness) {
    const json = jsonStringify({
      v: 1,
      channelKey: witness.channelKey,
      nonce: { sequence: witness.nonce },
      r: witness.r,
    });
    return json as Blob<string>;
  },
  decode(blob) {
    const parsed = jsonParse(blob as string);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Invalid witness payload");
    }
    const { channelKey, nonce, r } = parsed as Record<string, unknown>;
    const decodedChannelKey = assertChannelKey(channelKey);
    const decodedNonce = assertNoteNonce(nonce);
    const decodedR = assertBigInt(r);

    return new Witness(decodedChannelKey, decodedNonce, decodedR);
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

function assertBigInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" || typeof value === "string") {
    return BigInt(value);
  }
  throw new Error("Invalid bigint");
}

function assertNoteNonce(value: unknown): number {
  if (typeof value === "number") {
    assert(isUint(value), () => "Invalid nonce: must be a non-negative integer");
    return value;
  }
  // Backwards compatibility or object handling if strictly needed, but let's stick to simple number
  assert(
    value !== null && typeof value === "object",
    () => "Invalid nonce: expected number or object"
  );
  const { sequence } = value as Record<string, unknown>;
  assert(isUint(sequence), () => "Invalid nonce: sequence must be a non-negative integer");
  return sequence;
}

function assertTokenEntries(
  value: unknown
): Map<StarknetAddress, { tokenNonce: number; noteNonce: number }> {
  if (!Array.isArray(value)) {
    throw new Error("Invalid tokens");
  }
  const entries: [StarknetAddress, { tokenNonce: number; noteNonce: number }][] = value.map(
    (entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new Error("Invalid token entry");
      }
      const [token, nonces] = entry;
      const { tokenNonce, noteNonce } = nonces as { tokenNonce: unknown; noteNonce: unknown };
      return [
        token as StarknetAddress,
        {
          tokenNonce: assertTokenNonce(tokenNonce),
          noteNonce: assertNoteNonce(noteNonce),
        },
      ];
    }
  );
  return new Map(entries);
}

function assertTokenNonce(value: unknown): number {
  if (typeof value === "number") {
    assert(isUint(value), () => "Invalid nonce: must be a non-negative integer");
    return value;
  }
  assert(
    value !== null && typeof value === "object",
    () => "Invalid nonce: expected number or object"
  );
  const { sequence } = value as Record<string, unknown>;
  assert(isUint(sequence), () => "Invalid nonce: sequence must be a non-negative integer");
  return sequence;
}
