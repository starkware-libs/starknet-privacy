import { describe, expect, it } from "vitest";
import {
  channelSerde,
  witnessSerde,
  ChannelNonce,
  TokenNonce,
  Nonce,
  Channel,
  Witness,
} from "../src/internal.js";

describe("channelSerde", () => {
  it("encodes and decodes a channel round-trip", () => {
    const original = new Channel(
      12345n,
      [new ChannelNonce(0, 1), new ChannelNonce(1, 2)],
      new Map([
        ["0xabc", [new TokenNonce(0, 10), new TokenNonce(1, 20)]],
        ["0xdef", [new TokenNonce(2, 30)]],
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
    const original = new Witness(42n, new TokenNonce(3, 7));

    const decoded = witnessSerde.decode(witnessSerde.encode(original));

    expect(decoded).toEqual(original);
  });

  it("throws on invalid payload", () => {
    expect(() => witnessSerde.decode("null" as ReturnType<typeof witnessSerde.encode>)).toThrow(
      "Invalid witness payload"
    );
  });
});

describe("Nonce.next", () => {
  it("returns the oldest nonce incremented", () => {
    const nonces = [
      Object.assign(new ChannelNonce(0, 5), { created: 100 }),
      Object.assign(new ChannelNonce(1, 3), { created: 50 }), // oldest
      Object.assign(new ChannelNonce(2, 8), { created: 200 }),
    ];

    const next = Nonce.next(nonces);

    expect(next).toBeDefined();
    expect(next!.slot).toBe(1);
    expect(next!.sequence).toBe(4); // 3 + 1
  });

  it("throws when no nonces have created block number", () => {
    const nonces = [new ChannelNonce(0, 5), new ChannelNonce(1, 3)];

    expect(() => Nonce.next(nonces)).toThrow("No nonces with created block number");
  });

  it("works with TokenNonce as well", () => {
    const nonces = [
      Object.assign(new TokenNonce(10, 2), { created: 300 }),
      Object.assign(new TokenNonce(20, 1), { created: 100 }), // oldest
    ];

    const next = Nonce.next(nonces);

    expect(next).toBeDefined();
    expect(next!.slot).toBe(20);
    expect(next!.sequence).toBe(2); // 1 + 1
  });
});
