import { describe, expect, it } from "vitest";
import {
  channelSerde,
  witnessSerde,
  TokenNonce,
  NoteNonce,
  Channel,
  Witness,
} from "../src/internal.js";

describe("channelSerde", () => {
  it("encodes and decodes a channel round-trip", () => {
    const original = new Channel(
      12345n,
      [new TokenNonce(0, 1), new TokenNonce(1, 2)],
      new Map([
        ["0xabc", [new NoteNonce(0, 10), new NoteNonce(1, 20)]],
        ["0xdef", [new NoteNonce(0, 30)]],
      ])
    );

    const decoded = channelSerde.decode(channelSerde.encode(original));

    expect(decoded).toEqual(original);
  });

  it("throws on invalid payload", () => {
    expect(() => channelSerde.decode("null" as ReturnType<typeof channelSerde.encode>)).toThrow(
      "Invalid channel payload"
    );
  });
});

describe("witnessSerde", () => {
  it("encodes and decodes a witness round-trip", () => {
    const original = new Witness(42n, new NoteNonce(3, 7));

    const decoded = witnessSerde.decode(witnessSerde.encode(original));

    expect(decoded).toEqual(original);
  });

  it("throws on invalid payload", () => {
    expect(() => witnessSerde.decode("null" as ReturnType<typeof witnessSerde.encode>)).toThrow(
      "Invalid witness payload"
    );
  });
});

describe("ChannelNonce.increment", () => {
  it("increments the oldest nonce in-place and returns index and previous", () => {
    const nonces = [
      Object.assign(new TokenNonce(0, 5), { created: 100 }),
      Object.assign(new TokenNonce(1, 3), { created: 50 }), // oldest
      Object.assign(new TokenNonce(2, 8), { created: 200 }),
    ];

    const result = TokenNonce.increment(nonces);

    expect(result.index).toBe(1);
    expect(result.previous?.slot).toBe(1);
    expect(result.previous?.sequence).toBe(3);
    // Array was mutated
    expect(nonces[1].slot).toBe(1);
    expect(nonces[1].sequence).toBe(4); // 3 + 1
  });

  it("adds a new slot when no nonces have created block number", () => {
    const nonces: TokenNonce[] = [];

    const result = TokenNonce.increment(nonces);

    expect(result.index).toBe(0);
    expect(result.previous).toBeUndefined();
    expect(nonces.length).toBe(1);
    expect(nonces[0].slot).toBe(0);
    expect(nonces[0].sequence).toBe(0);
  });

  it("adds a new slot at the end when existing nonces lack created", () => {
    const nonces = [new TokenNonce(0, 5), new TokenNonce(1, 3)];

    const result = TokenNonce.increment(nonces);

    expect(result.index).toBe(2);
    expect(result.previous).toBeUndefined();
    expect(nonces.length).toBe(3);
    expect(nonces[2].slot).toBe(2);
    expect(nonces[2].sequence).toBe(0);
  });

  it("throws when max slots reached and no nonces have created", () => {
    // Create array with MAX_SLOTS nonces, none with created
    const nonces = Array.from({ length: TokenNonce.MAX_SLOTS }, (_, i) => new TokenNonce(i, 0));

    expect(() => TokenNonce.increment(nonces)).toThrow(
      `Cannot add new slot: already at max slots (${TokenNonce.MAX_SLOTS})`
    );
  });

  it("throws when slots are not sequential", () => {
    const nonces = [
      Object.assign(new TokenNonce(0, 1), { created: 100 }),
      Object.assign(new TokenNonce(2, 1), { created: 200 }), // gap: should be slot 1
    ];

    expect(() => TokenNonce.increment(nonces)).toThrow(
      "Invalid nonce array: expected slot 1, got 2"
    );
  });
});

describe("TokenNonce.increment", () => {
  it("increments the oldest nonce in-place", () => {
    const nonces = [
      Object.assign(new NoteNonce(0, 2), { created: 300 }),
      Object.assign(new NoteNonce(1, 1), { created: 100 }), // oldest
    ];

    const result = NoteNonce.increment(nonces);

    expect(result.index).toBe(1);
    expect(result.previous?.sequence).toBe(1);
    expect(nonces[1].sequence).toBe(2); // 1 + 1
  });

  it("respects TokenNonce.MAX_SLOTS", () => {
    // Create array with MAX_SLOTS nonces, none with created
    const nonces = Array.from({ length: NoteNonce.MAX_SLOTS }, (_, i) => new NoteNonce(i, 0));

    expect(() => NoteNonce.increment(nonces)).toThrow(
      `Cannot add new slot: already at max slots (${NoteNonce.MAX_SLOTS})`
    );
  });
});
