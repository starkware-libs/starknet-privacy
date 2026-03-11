import { describe, expect, it } from "vitest";
import { buildHistoryCursor, type HistorySubchannel } from "../../src/internal/indexer/history.js";
import type {
  NotesCursor,
  ChannelCursor,
  IncomingChannelCursor,
} from "../../src/internal/channel.js";
import { Channel } from "../../src/internal/channel.js";
import { AddressMap } from "../../src/utils/maps.js";

const ALICE = 0x1n;
const BOB = 0x2n;
const CHARLIE = 0x3n;
const TOKEN_A = 0xaa1n;
const TOKEN_B = 0xaa2n;
const CHANNEL_KEY_SELF = 100n;
const CHANNEL_KEY_BOB = 200n;
const CHANNEL_KEY_CHARLIE = 300n;

function makeNotesCursor(entries: [bigint, IncomingChannelCursor][]): NotesCursor {
  return {
    blockId: 0,
    incomingChannels: new AddressMap<IncomingChannelCursor>(entries),
  };
}

function makeChannelCursor(entries: [bigint, Channel][]): ChannelCursor {
  return {
    blockId: 0,
    channels: new AddressMap<Channel>(entries),
  };
}

function findSubchannels(
  subchannels: HistorySubchannel[],
  filter: Partial<HistorySubchannel>
): HistorySubchannel[] {
  return subchannels.filter((subchannel) =>
    Object.entries(filter).every(
      ([key, value]) => subchannel[key as keyof HistorySubchannel] === value
    )
  );
}

describe("buildHistoryCursor", () => {
  it("self-channel appears once with channelKind 'self_channel', not duplicated", () => {
    // Alice has a self-channel: appears in both incoming (sender=Alice) and outgoing (recipient=Alice)
    const notesCursor = makeNotesCursor([
      [
        ALICE,
        {
          channelKey: CHANNEL_KEY_SELF,
          subchannelIdIndex: 0,
          noteIndexes: new AddressMap<number>([[TOKEN_A, 3]]),
        },
      ],
    ]);

    const selfChannel = new Channel(0n, CHANNEL_KEY_SELF);
    selfChannel.tokens.set(TOKEN_A, { tokenIndex: 0, noteNonce: 3 });

    const channelCursor = makeChannelCursor([[ALICE, selfChannel]]);

    const cursor = buildHistoryCursor(ALICE, notesCursor, channelCursor);

    const selfSubchannels = findSubchannels(cursor.subchannels, {
      channelKey: CHANNEL_KEY_SELF,
      token: TOKEN_A,
    });
    expect(selfSubchannels).toHaveLength(1);
    expect(selfSubchannels[0].channelKind).toBe("self_channel");
    expect(selfSubchannels[0].counterparty).toBe(ALICE);
  });

  it("regular incoming channels are tagged 'incoming'", () => {
    const notesCursor = makeNotesCursor([
      [
        BOB,
        {
          channelKey: CHANNEL_KEY_BOB,
          subchannelIdIndex: 0,
          noteIndexes: new AddressMap<number>([[TOKEN_A, 5]]),
        },
      ],
    ]);

    const channelCursor = makeChannelCursor([]);

    const cursor = buildHistoryCursor(ALICE, notesCursor, channelCursor);

    expect(cursor.subchannels).toHaveLength(1);
    expect(cursor.subchannels[0].channelKind).toBe("incoming");
    expect(cursor.subchannels[0].counterparty).toBe(BOB);
    expect(cursor.subchannels[0].nextIndex).toBe(4);
  });

  it("regular outgoing channels are tagged 'outgoing'", () => {
    const notesCursor = makeNotesCursor([]);

    const outgoingChannel = new Channel(0n, CHANNEL_KEY_BOB);
    outgoingChannel.tokens.set(TOKEN_A, { tokenIndex: 0, noteNonce: 2 });

    const channelCursor = makeChannelCursor([[BOB, outgoingChannel]]);

    const cursor = buildHistoryCursor(ALICE, notesCursor, channelCursor);

    expect(cursor.subchannels).toHaveLength(1);
    expect(cursor.subchannels[0].channelKind).toBe("outgoing");
    expect(cursor.subchannels[0].counterparty).toBe(BOB);
    expect(cursor.subchannels[0].nextIndex).toBe(1);
  });

  it("mixed scenario: self-channel + incoming from Bob + outgoing to Charlie", () => {
    const notesCursor = makeNotesCursor([
      [
        ALICE,
        {
          channelKey: CHANNEL_KEY_SELF,
          subchannelIdIndex: 0,
          noteIndexes: new AddressMap<number>([[TOKEN_A, 1]]),
        },
      ],
      [
        BOB,
        {
          channelKey: CHANNEL_KEY_BOB,
          subchannelIdIndex: 0,
          noteIndexes: new AddressMap<number>([[TOKEN_A, 2]]),
        },
      ],
    ]);

    const selfChannel = new Channel(0n, CHANNEL_KEY_SELF);
    selfChannel.tokens.set(TOKEN_A, { tokenIndex: 0, noteNonce: 1 });

    const outgoingChannel = new Channel(0n, CHANNEL_KEY_CHARLIE);
    outgoingChannel.tokens.set(TOKEN_B, { tokenIndex: 0, noteNonce: 4 });

    const channelCursor = makeChannelCursor([
      [ALICE, selfChannel],
      [CHARLIE, outgoingChannel],
    ]);

    const cursor = buildHistoryCursor(ALICE, notesCursor, channelCursor);

    // 3 total: self_channel, incoming from Bob, outgoing to Charlie
    expect(cursor.subchannels).toHaveLength(3);

    const selfSubchannels = findSubchannels(cursor.subchannels, { channelKind: "self_channel" });
    expect(selfSubchannels).toHaveLength(1);
    expect(selfSubchannels[0].counterparty).toBe(ALICE);
    expect(selfSubchannels[0].token).toBe(TOKEN_A);

    const incomingSubchannels = findSubchannels(cursor.subchannels, { channelKind: "incoming" });
    expect(incomingSubchannels).toHaveLength(1);
    expect(incomingSubchannels[0].counterparty).toBe(BOB);

    const outgoingSubchannels = findSubchannels(cursor.subchannels, { channelKind: "outgoing" });
    expect(outgoingSubchannels).toHaveLength(1);
    expect(outgoingSubchannels[0].counterparty).toBe(CHARLIE);
    expect(outgoingSubchannels[0].token).toBe(TOKEN_B);
  });

  it("nextIndex is undefined when noteIndex or noteNonce is 0", () => {
    const notesCursor = makeNotesCursor([
      [
        BOB,
        {
          channelKey: CHANNEL_KEY_BOB,
          subchannelIdIndex: 0,
          noteIndexes: new AddressMap<number>([[TOKEN_A, 0]]),
        },
      ],
    ]);

    const outgoingChannel = new Channel(0n, CHANNEL_KEY_CHARLIE);
    outgoingChannel.tokens.set(TOKEN_A, { tokenIndex: 0, noteNonce: 0 });

    const channelCursor = makeChannelCursor([[CHARLIE, outgoingChannel]]);

    const cursor = buildHistoryCursor(ALICE, notesCursor, channelCursor);

    expect(cursor.subchannels).toHaveLength(2);
    for (const subchannel of cursor.subchannels) {
      expect(subchannel.nextIndex).toBeUndefined();
    }
  });

  it("outgoing channel without key is skipped", () => {
    const notesCursor = makeNotesCursor([]);

    // Channel with no key set
    const channelWithoutKey = new Channel(0n);
    channelWithoutKey.tokens.set(TOKEN_A, { tokenIndex: 0, noteNonce: 1 });

    const channelCursor = makeChannelCursor([[BOB, channelWithoutKey]]);

    const cursor = buildHistoryCursor(ALICE, notesCursor, channelCursor);

    expect(cursor.subchannels).toHaveLength(0);
  });
});
