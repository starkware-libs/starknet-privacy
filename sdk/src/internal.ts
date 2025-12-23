import { BigNumberish, BlockNumber, BlockIdentifier } from "starknet";
import {
  Blob,
  Channel,
  ChannelSerde,
  StarknetAddress,
  Witness,
  WitnessSerde,
  channelBrand,
  witnessBrand,
} from "./interfaces.js";

// Base nonce class with shared logic and methods.
class Nonce {
  created?: BlockNumber;
  readonly nonce0: number;
  readonly nonce1: number;

  protected constructor(nonce0: number, nonce1: number, max: number, created?: BlockNumber) {
    if (
      typeof nonce0 !== "number" ||
      !Number.isInteger(nonce0) ||
      nonce0 < 0 ||
      nonce0 > max ||
      typeof nonce1 !== "number"
    ) {
      throw new Error("Invalid nonce");
    }
    this.nonce0 = nonce0;
    this.nonce1 = nonce1;
    this.created = created;
  }

  /** Returns a new instance of the same class with nonce1 incremented by 1. */
  increment(): this {
    const Ctor = this.constructor as new (nonce0: number, nonce1: number) => this;
    return new Ctor(this.nonce0, this.nonce1 + 1);
  }

  /**
   * Finds the nonce with the lowest `created` value (skipping those without one)
   * and returns its increment. Returns undefined if no nonces have `created`.
   */
  static next<T extends Nonce>(this: { new (...args: unknown[]): T }, nonces: T[]): T | undefined {
    const withCreated = nonces.filter((n): n is T & { created: BlockNumber } => n.created != null);
    if (withCreated.length === 0) return undefined;

    const oldest = withCreated.reduce((min, n) => (n.created! < min.created! ? n : min));
    
    // TODO: add a check the oldest is old enough (at least 10 blocks old)

    return oldest.increment() as T;
  }
}

// Factory that creates a subclass of Nonce with a specific static MAX.
function withMax<TMax extends number>(max: TMax) {
  return class extends Nonce {
    static readonly MAX: TMax = max;

    constructor(nonce0: number, nonce1: number) {
      super(nonce0, nonce1, max);
    }
  };
}

const ChannelNonceClass = withMax(10);
const TokenNonceClass = withMax(256);

type ChannelNonce = InstanceType<typeof ChannelNonceClass>;
type TokenNonce = InstanceType<typeof TokenNonceClass>;

type ChannelKey = bigint;

type InternalChannel = Channel & {
  key: ChannelKey;
  nonces: ChannelNonce[]; // for new tokens. array of nonces (per nonce0) that have been used for the channel. 
  tokens: Map<StarknetAddress, TokenNonce[]>; // for new notes. array of nonces (per nonce0) for each token. 
};


export const channelSerde: ChannelSerde = {
  encode(channel) {
    const internal = channel as InternalChannel;
    const json = JSON.stringify({
      v: 1,
      key: internal.key,
      nonces: internal.nonces,
      tokens: Array.from(internal.tokens.entries()),
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

    const channel: InternalChannel = {
      key: decodedKey,
      nonces: decodedNonces,
      tokens: decodedTokens,
      [channelBrand]: true,
    };
    return channel;
  },
};

type InternalWitness = Witness & {
  channelKey: ChannelKey;
  nonce: TokenNonce;
};

export const witnessSerde: WitnessSerde = {
  encode(ctx) {
    const internal = ctx as InternalWitness;
    const json = JSON.stringify({
      v: 1,
      channelKey: internal.channelKey,
      nonce: internal.nonce,
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

    const ctx: InternalWitness = {
      channelKey: decodedChannelKey,
      nonce: decodedNonce,
      [witnessBrand]: true,
    };
    return ctx;
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
  if (value instanceof ChannelNonceClass) {
    return value;
  }
  if (value === null || typeof value !== "object") {
    throw new Error("Invalid nonce");
  }
  const { nonce0, nonce1 } = value as Record<string, unknown>;
  return new ChannelNonceClass(nonce0 as number, nonce1 as number);
}

function assertTokenNonce(value: unknown): TokenNonce {
  if (value instanceof TokenNonceClass) {
    return value;
  }
  if (value === null || typeof value !== "object") {
    throw new Error("Invalid nonce");
  }
  const { nonce0, nonce1 } = value as Record<string, unknown>;
  return new TokenNonceClass(nonce0 as number, nonce1 as number);
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
