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
      new TokenNonce(5),
      new Map([
        ["0xabc", new NoteNonce(10)],
        ["0xdef", new NoteNonce(30)],
      ])
    );

    const decoded = channelSerde.decode(channelSerde.encode(original));

    // Compare essential data (AdvressMap instances don't deep-equal well)
    expect(decoded.key).toEqual(original.key);
    expect(decoded.tokenNonce.sequence).toEqual(original.tokenNonce.sequence);
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
    const original = new Witness(42n, new NoteNonce(7));

    const decoded = witnessSerde.decode(witnessSerde.encode(original));

    expect(decoded.channelKey).toEqual(original.channelKey);
    expect(decoded.nonce.sequence).toEqual(original.nonce.sequence);
  });

  it("throws on invalid payload", () => {
    expect(() => witnessSerde.decode("null" as ReturnType<typeof witnessSerde.encode>)).toThrow(
      "Invalid witness payload"
    );
  });
});
