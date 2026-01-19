import { describe, expect, it } from "vitest";
import { channelSerde, witnessSerde, Channel, Witness } from "../../src/internal/index.js";

describe("channelSerde", () => {
  it("encodes and decodes a channel round-trip", () => {
    const original = new Channel(
      67890n, // publicKey
      12345n,
      new Map([
        ["0xabc", { tokenNonce: 1, noteNonce: 10 }],
        ["0xdef", { tokenNonce: 2, noteNonce: 30 }],
      ])
    );

    const decoded = channelSerde.decode(channelSerde.encode(original));

    // Compare essential data (AdvressMap instances don't deep-equal well)
    expect(decoded.key).toEqual(original.key);
    expect(decoded.publicKey).toEqual(original.publicKey);
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
    const original = new Witness(42n, 7, 666n);

    const decoded = witnessSerde.decode(witnessSerde.encode(original));

    expect(decoded.channelKey).toEqual(original.channelKey);
    expect(decoded.nonce).toEqual(original.nonce);
  });

  it("throws on invalid payload", () => {
    expect(() => witnessSerde.decode("null" as ReturnType<typeof witnessSerde.encode>)).toThrow(
      "Invalid witness payload"
    );
  });
});
