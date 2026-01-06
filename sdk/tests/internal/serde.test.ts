import { describe, expect, it } from "vitest";
import {
  channelSerde,
  witnessSerde,
  TokenNonce,
  NoteNonce,
  Channel,
  Witness,
} from "../../src/internal/index.js";

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

    // Compare essential data (AdvancedMap instances don't deep-equal well)
    expect(decoded.key).toEqual(original.key);
    expect(decoded.nonces).toEqual(original.nonces);
    expect(Array.from(decoded.tokens.entries())).toEqual(Array.from(original.tokens.entries()));
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
