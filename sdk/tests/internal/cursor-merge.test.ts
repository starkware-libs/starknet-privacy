import { describe, expect, it } from "vitest";
import { Channel, mergeChannelCursor, mergeNotesCursor } from "../../src/internal/channel.js";
import type {
  ChannelCursor,
  NotesCursor,
  IncomingChannelCursor,
} from "../../src/internal/channel.js";
import { AddressMap } from "../../src/utils/maps.js";

const ALICE = 0xa11cen;
const BOB = 0xb0bn;
const CAROL = 0xca201n;

const TOKEN_A = 0xace1n;
const TOKEN_B = 0xbee1n;
const TOKEN_C = 0xcee1n;

function makeChannel(publicKey: bigint, key: bigint): Channel {
  return new Channel(publicKey, key);
}

function makeIncomingChannelCursor(
  channelKey: bigint,
  subchannelIdIndex: number,
  noteIndexes: [bigint, number][],
  totalNoteCounts: [bigint, number][]
): IncomingChannelCursor {
  return {
    channelKey,
    subchannelIdIndex,
    noteIndexes: new AddressMap<number>(noteIndexes),
    totalNoteCounts: new AddressMap<number>(totalNoteCounts),
  };
}

describe("mergeChannelCursor", () => {
  it("preserves channels not in update (recipient-filtered discovery)", () => {
    const target: ChannelCursor = {
      blockId: "0xblock1",
      total: 2,
      channels: new AddressMap<Channel>([
        [ALICE, makeChannel(0x1n, 0x10n)],
        [BOB, makeChannel(0x2n, 0x20n)],
      ]),
    };

    // Discovery only returned Carol (new) — Alice and Bob should be preserved
    const update: ChannelCursor = {
      blockId: "0xblock2",
      total: 3,
      channels: new AddressMap<Channel>([[CAROL, makeChannel(0x3n, 0x30n)]]),
    };

    mergeChannelCursor(target, update);

    expect(target.blockId).toBe("0xblock2");
    expect(target.total).toBe(3);
    expect(target.channels!.get(ALICE)!.key).toBe(0x10n);
    expect(target.channels!.get(BOB)!.key).toBe(0x20n);
    expect(target.channels!.get(CAROL)!.key).toBe(0x30n);
  });

  it("overwrites channels present in both target and update", () => {
    const target: ChannelCursor = {
      blockId: "0xblock1",
      total: 2,
      channels: new AddressMap<Channel>([
        [ALICE, makeChannel(0x1n, 0x10n)],
        [BOB, makeChannel(0x2n, 0x20n)],
      ]),
    };

    // Discovery refreshed Alice with updated key
    const update: ChannelCursor = {
      blockId: "0xblock2",
      total: 2,
      channels: new AddressMap<Channel>([[ALICE, makeChannel(0x1n, 0x99n)]]),
    };

    mergeChannelCursor(target, update);

    expect(target.channels!.get(ALICE)!.key).toBe(0x99n);
    expect(target.channels!.get(BOB)!.key).toBe(0x20n);
  });

  it("initializes channels map when target has no channels", () => {
    const target: ChannelCursor = { blockId: "0xblock1" };

    const update: ChannelCursor = {
      blockId: "0xblock2",
      total: 1,
      channels: new AddressMap<Channel>([[ALICE, makeChannel(0x1n, 0x10n)]]),
    };

    mergeChannelCursor(target, update);
    expect(target.channels!.has(ALICE)).toBe(true);
  });
});

describe("mergeNotesCursor", () => {
  it("adds new senders from update", () => {
    const target: NotesCursor = {
      blockId: "0xblock1",
      incomingChannels: new AddressMap<IncomingChannelCursor>([
        [ALICE, makeIncomingChannelCursor(0x1n, 2, [[TOKEN_A, 5]], [[TOKEN_A, 10]])],
      ]),
    };

    const update: NotesCursor = {
      blockId: "0xblock2",
      incomingChannels: new AddressMap<IncomingChannelCursor>([
        [BOB, makeIncomingChannelCursor(0x2n, 1, [[TOKEN_A, 3]], [[TOKEN_A, 8]])],
      ]),
    };

    mergeNotesCursor(target, update);

    expect(target.blockId).toBe("0xblock2");
    expect(target.incomingChannels.has(ALICE)).toBe(true);
    expect(target.incomingChannels.has(BOB)).toBe(true);
  });

  it("preserves token cursors not in update (token-filtered discovery)", () => {
    // Existing cursor has data for TOKEN_A and TOKEN_B from Alice
    const target: NotesCursor = {
      blockId: "0xblock1",
      incomingChannels: new AddressMap<IncomingChannelCursor>([
        [
          ALICE,
          makeIncomingChannelCursor(
            0x1n,
            3,
            [
              [TOKEN_A, 5],
              [TOKEN_B, 8],
            ],
            [
              [TOKEN_A, 10],
              [TOKEN_B, 16],
            ]
          ),
        ],
      ]),
    };

    // Discovery was filtered to TOKEN_C only — TOKEN_A and TOKEN_B should be preserved
    const update: NotesCursor = {
      blockId: "0xblock2",
      incomingChannels: new AddressMap<IncomingChannelCursor>([
        [ALICE, makeIncomingChannelCursor(0x1n, 4, [[TOKEN_C, 2]], [[TOKEN_C, 6]])],
      ]),
    };

    mergeNotesCursor(target, update);

    const aliceCursor = target.incomingChannels.get(ALICE)!;
    // Preserved from target
    expect(aliceCursor.noteIndexes.get(TOKEN_A)).toBe(5);
    expect(aliceCursor.noteIndexes.get(TOKEN_B)).toBe(8);
    expect(aliceCursor.totalNoteCounts.get(TOKEN_A)).toBe(10);
    expect(aliceCursor.totalNoteCounts.get(TOKEN_B)).toBe(16);
    // Added from update
    expect(aliceCursor.noteIndexes.get(TOKEN_C)).toBe(2);
    expect(aliceCursor.totalNoteCounts.get(TOKEN_C)).toBe(6);
    // subchannelIdIndex updated
    expect(aliceCursor.subchannelIdIndex).toBe(4);
  });

  it("overwrites token cursors present in both target and update", () => {
    const target: NotesCursor = {
      blockId: "0xblock1",
      incomingChannels: new AddressMap<IncomingChannelCursor>([
        [
          ALICE,
          makeIncomingChannelCursor(
            0x1n,
            2,
            [
              [TOKEN_A, 5],
              [TOKEN_B, 8],
            ],
            [
              [TOKEN_A, 10],
              [TOKEN_B, 16],
            ]
          ),
        ],
      ]),
    };

    // Discovery refreshed TOKEN_A with new values
    const update: NotesCursor = {
      blockId: "0xblock2",
      incomingChannels: new AddressMap<IncomingChannelCursor>([
        [ALICE, makeIncomingChannelCursor(0x1n, 3, [[TOKEN_A, 12]], [[TOKEN_A, 20]])],
      ]),
    };

    mergeNotesCursor(target, update);

    const aliceCursor = target.incomingChannels.get(ALICE)!;
    // TOKEN_A overwritten
    expect(aliceCursor.noteIndexes.get(TOKEN_A)).toBe(12);
    expect(aliceCursor.totalNoteCounts.get(TOKEN_A)).toBe(20);
    // TOKEN_B preserved
    expect(aliceCursor.noteIndexes.get(TOKEN_B)).toBe(8);
    expect(aliceCursor.totalNoteCounts.get(TOKEN_B)).toBe(16);
  });

  it("handles mixed: new sender + existing sender with token filter", () => {
    const target: NotesCursor = {
      blockId: "0xblock1",
      incomingChannels: new AddressMap<IncomingChannelCursor>([
        [ALICE, makeIncomingChannelCursor(0x1n, 2, [[TOKEN_A, 5]], [[TOKEN_A, 10]])],
      ]),
    };

    const update: NotesCursor = {
      blockId: "0xblock2",
      incomingChannels: new AddressMap<IncomingChannelCursor>([
        // Alice: add TOKEN_B subchannel
        [ALICE, makeIncomingChannelCursor(0x1n, 3, [[TOKEN_B, 1]], [[TOKEN_B, 4]])],
        // Bob: entirely new sender
        [BOB, makeIncomingChannelCursor(0x2n, 1, [[TOKEN_A, 3]], [[TOKEN_A, 7]])],
      ]),
    };

    mergeNotesCursor(target, update);

    // Alice: TOKEN_A preserved, TOKEN_B added
    const aliceCursor = target.incomingChannels.get(ALICE)!;
    expect(aliceCursor.noteIndexes.get(TOKEN_A)).toBe(5);
    expect(aliceCursor.noteIndexes.get(TOKEN_B)).toBe(1);
    expect(aliceCursor.subchannelIdIndex).toBe(3);

    // Bob: new entry
    const bobCursor = target.incomingChannels.get(BOB)!;
    expect(bobCursor.noteIndexes.get(TOKEN_A)).toBe(3);
    expect(bobCursor.totalNoteCounts.get(TOKEN_A)).toBe(7);
  });
});
