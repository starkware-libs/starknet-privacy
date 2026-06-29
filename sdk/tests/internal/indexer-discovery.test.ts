import { describe, expect, it, vi, afterEach } from "vitest";
import {
  IndexerDiscoveryProvider,
  ReorgError,
  notesCursorToApiCursor,
  apiCursorToNotesCursor,
  convertIncomingNotes,
  buildSubchannelCursors,
} from "../../src/internal/indexer-discovery.js";
import { SetupRequirement } from "../../src/interfaces.js";
import { AddressMap } from "../../src/utils/maps.js";
import type { IncomingChannelCursor, NotesCursor } from "../../src/internal/channel.js";

const API_URL = "http://test-indexer:8080";
const USER_ADDRESS = 0xa11cen;
const VIEWING_KEY = 0xbeefn;
const BLOCK_REF = "0xb10c1";
const SENDER_ADDR = "0xaaa1";
const TOKEN_ADDR = "0xace1";
const TOKEN_ADDR_2 = "0xace2";
const RECIPIENT_ADDR = "0xbbb1";
const RECIPIENT_ADDR_2 = "0xbbb2";
const CHANNEL_KEY_1 = "0xcc1";
const CHANNEL_KEY_2 = "0xcc2";
const PUBLIC_KEY_1 = "0xaa1";
const PUBLIC_KEY_2 = "0xaa2";

function mockFetchJson(...responses: { body: unknown; status?: number }[]) {
  const mockFn = vi.fn();
  for (const resp of responses) {
    const status = resp.status ?? 200;
    mockFn.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(resp.body),
      text: () => Promise.resolve(JSON.stringify(resp.body)),
    });
  }
  globalThis.fetch = mockFn;
  return mockFn;
}

function createProvider(): IndexerDiscoveryProvider {
  return new IndexerDiscoveryProvider(API_URL, "0x123");
}

/** A complete cursor with no channels -- signals "nothing left to discover". */
const EMPTY_COMPLETE_CURSOR = { channel_discovery_complete: true, channels: {} } as const;

/** Builds a complete API cursor with fully-discovered channels and subchannels. */
function completeCursor(
  channels: Record<string, { channel_key: string; subchannels?: Record<string, unknown> }>
): Record<string, unknown> {
  const apiChannels: Record<string, unknown> = {};
  for (const [addr, ch] of Object.entries(channels)) {
    apiChannels[addr] = {
      channel_key: ch.channel_key,
      subchannel_discovery_complete: true,
      subchannels: ch.subchannels ?? {},
    };
  }
  return { channel_discovery_complete: true, channels: apiChannels };
}

/** Builds an incomplete API cursor (channel discovery still in progress). */
function incompleteCursor(
  channels: Record<string, { channel_key: string; subchannels?: Record<string, unknown> }>
): Record<string, unknown> {
  const apiChannels: Record<string, unknown> = {};
  for (const [addr, ch] of Object.entries(channels)) {
    apiChannels[addr] = {
      channel_key: ch.channel_key,
      subchannel_discovery_complete: false,
      subchannels: ch.subchannels ?? {},
    };
  }
  return { channel_discovery_complete: false, channels: apiChannels };
}

function incomingSyncResponse(overrides: Record<string, unknown> = {}) {
  return {
    block_ref: BLOCK_REF,
    channels: [],
    subchannels: [],
    notes: [],
    cursor: EMPTY_COMPLETE_CURSOR,
    ...overrides,
  };
}

function outgoingSyncResponse(overrides: Record<string, unknown> = {}) {
  return {
    block_ref: BLOCK_REF,
    channels: [],
    subchannels: [],
    cursor: EMPTY_COMPLETE_CURSOR,
    ...overrides,
  };
}

function noteEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sender_addr: SENDER_ADDR,
    token: TOKEN_ADDR,
    index: 0,
    note_id: "0xde1",
    amount: "100",
    salt: "42",
    ...overrides,
  };
}

function channelEntry(
  recipientAddr: string,
  publicKey: string,
  channelKey: string,
  extra: Record<string, unknown> = {}
) {
  return {
    recipient_addr: recipientAddr,
    recipient_public_key: publicKey,
    channel_key: channelKey,
    ...extra,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IndexerDiscoveryProvider", () => {
  describe("discoverNotes", () => {
    it("returns notes from a single complete page", async () => {
      const provider = createProvider();
      const fetchMock = mockFetchJson({
        body: incomingSyncResponse({
          channels: [{ channel_key: CHANNEL_KEY_1, sender_addr: SENDER_ADDR }],
          notes: [noteEntry()],
          cursor: completeCursor({
            [SENDER_ADDR]: {
              channel_key: CHANNEL_KEY_1,
              subchannels: {
                [TOKEN_ADDR]: { note_discovery_complete: true, last_note_index: 0 },
              },
            },
          }),
        }),
      });

      const result = await provider.discoverNotes(USER_ADDRESS, VIEWING_KEY);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(result.timestamp).toBe(BLOCK_REF);

      const tokenNotes = result.notes.get(BigInt(TOKEN_ADDR));
      expect(tokenNotes).toHaveLength(1);
      const note = tokenNotes![0];
      expect(note.id).toBe("0xde1");
      expect(note.amount).toBe(100n);
      expect(note.witness.channelKey).toBe(BigInt(CHANNEL_KEY_1));
      expect(note.witness.nonce).toBe(0);
      expect(note.sender).toBe(BigInt(SENDER_ADDR));
      expect(note.open).toBe(false);
      expect(result.cursor.blockId).toBe(BLOCK_REF);
    });

    it("paginates across 2 pages and merges notes", async () => {
      const provider = createProvider();
      const fetchMock = mockFetchJson(
        {
          body: incomingSyncResponse({
            channels: [{ channel_key: CHANNEL_KEY_1, sender_addr: SENDER_ADDR }],
            notes: [noteEntry({ amount: "50", salt: "10" })],
            cursor: incompleteCursor({
              [SENDER_ADDR]: { channel_key: CHANNEL_KEY_1 },
            }),
          }),
        },
        {
          body: incomingSyncResponse({
            notes: [noteEntry({ index: 1, note_id: "0xde2", amount: "75", salt: "20" })],
            cursor: completeCursor({
              [SENDER_ADDR]: {
                channel_key: CHANNEL_KEY_1,
                subchannels: {
                  [TOKEN_ADDR]: { note_discovery_complete: true, last_note_index: 1 },
                },
              },
            }),
          }),
        }
      );

      const result = await provider.discoverNotes(USER_ADDRESS, VIEWING_KEY);

      expect(fetchMock).toHaveBeenCalledTimes(2);

      const secondCallBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(secondCallBody.block_ref).toBe(BLOCK_REF);

      const tokenNotes = result.notes.get(BigInt(TOKEN_ADDR));
      expect(tokenNotes).toHaveLength(2);
      expect(tokenNotes![0].id).toBe("0xde1");
      expect(tokenNotes![1].id).toBe("0xde2");
    });

    it("filters notes by token when tokens param is provided", async () => {
      const provider = createProvider();
      mockFetchJson({
        body: incomingSyncResponse({
          channels: [{ channel_key: CHANNEL_KEY_1, sender_addr: SENDER_ADDR }],
          notes: [
            noteEntry({ amount: "50", salt: "1" }),
            noteEntry({ token: TOKEN_ADDR_2, note_id: "0xde2", amount: "75", salt: "2" }),
          ],
          cursor: completeCursor({
            [SENDER_ADDR]: {
              channel_key: CHANNEL_KEY_1,
              subchannels: {
                [TOKEN_ADDR]: { note_discovery_complete: true, last_note_index: 0 },
                [TOKEN_ADDR_2]: { note_discovery_complete: true, last_note_index: 0 },
              },
            },
          }),
        }),
      });

      const result = await provider.discoverNotes(USER_ADDRESS, VIEWING_KEY, {
        tokens: [BigInt(TOKEN_ADDR)],
      });

      const token1Notes = result.notes.get(BigInt(TOKEN_ADDR));
      expect(token1Notes).toHaveLength(1);
      expect(token1Notes![0].id).toBe("0xde1");
      expect(token1Notes![0].open).toBe(true); // salt === 1

      const token2Notes = result.notes.get(BigInt(TOKEN_ADDR_2));
      expect(token2Notes ?? []).toHaveLength(0);
    });

    it("throws ReorgError on HTTP 409", async () => {
      const provider = createProvider();
      mockFetchJson({ body: { error: "BLOCK_REORGED" }, status: 409 });

      await expect(provider.discoverNotes(USER_ADDRESS, VIEWING_KEY)).rejects.toThrow(ReorgError);
    });
  });

  describe("discoverChannels", () => {
    it("returns channels for 'all' recipients on a single page", async () => {
      const provider = createProvider();
      const fetchMock = mockFetchJson({
        body: outgoingSyncResponse({
          channels: [channelEntry(RECIPIENT_ADDR, PUBLIC_KEY_1, CHANNEL_KEY_1)],
          subchannels: [{ recipient_addr: RECIPIENT_ADDR, token: TOKEN_ADDR, last_note_index: 2 }],
          cursor: completeCursor({
            [RECIPIENT_ADDR]: {
              channel_key: CHANNEL_KEY_1,
              subchannels: {
                [TOKEN_ADDR]: { note_discovery_complete: true, last_note_index: 2 },
              },
            },
          }),
        }),
      });

      const result = await provider.discoverChannels(USER_ADDRESS, VIEWING_KEY, "all");

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(result.timestamp).toBe(BLOCK_REF);

      const channel = result.channels!.get(BigInt(RECIPIENT_ADDR));
      expect(channel).toBeDefined();
      expect(channel!.key).toBe(BigInt(CHANNEL_KEY_1));
      expect(channel!.publicKey).toBe(BigInt(PUBLIC_KEY_1));

      const tokenNonces = channel!.tokens.get(BigInt(TOKEN_ADDR));
      expect(tokenNonces).toBeDefined();
      expect(tokenNonces!.noteNonce).toBe(3); // last_note_index 2 + 1
    });

    it("paginates 'all' recipients across 2 pages and merges", async () => {
      const provider = createProvider();
      const fetchMock = mockFetchJson(
        {
          body: outgoingSyncResponse({
            channels: [channelEntry(RECIPIENT_ADDR, PUBLIC_KEY_1, CHANNEL_KEY_1)],
            cursor: incompleteCursor({
              [RECIPIENT_ADDR]: { channel_key: CHANNEL_KEY_1 },
            }),
          }),
        },
        {
          body: outgoingSyncResponse({
            channels: [channelEntry(RECIPIENT_ADDR_2, PUBLIC_KEY_2, CHANNEL_KEY_2)],
            subchannels: [
              { recipient_addr: RECIPIENT_ADDR, token: TOKEN_ADDR, last_note_index: 0 },
            ],
            cursor: completeCursor({
              [RECIPIENT_ADDR]: {
                channel_key: CHANNEL_KEY_1,
                subchannels: {
                  [TOKEN_ADDR]: { note_discovery_complete: true, last_note_index: 0 },
                },
              },
              [RECIPIENT_ADDR_2]: { channel_key: CHANNEL_KEY_2 },
            }),
          }),
        }
      );

      const result = await provider.discoverChannels(USER_ADDRESS, VIEWING_KEY, "all");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.channels!.has(BigInt(RECIPIENT_ADDR))).toBe(true);
      expect(result.channels!.has(BigInt(RECIPIENT_ADDR_2))).toBe(true);
      expect(result.channels!.get(BigInt(RECIPIENT_ADDR_2))!.key).toBe(BigInt(CHANNEL_KEY_2));
    });

    it("sends recipients array in request body for specific recipients", async () => {
      const provider = createProvider();
      const fetchMock = mockFetchJson({
        body: outgoingSyncResponse({
          channels: [
            channelEntry(RECIPIENT_ADDR, PUBLIC_KEY_1, CHANNEL_KEY_1),
            channelEntry(RECIPIENT_ADDR_2, PUBLIC_KEY_2, CHANNEL_KEY_2),
          ],
          cursor: completeCursor({
            [RECIPIENT_ADDR]: { channel_key: CHANNEL_KEY_1 },
            [RECIPIENT_ADDR_2]: { channel_key: CHANNEL_KEY_2 },
          }),
        }),
      });

      const result = await provider.discoverChannels(USER_ADDRESS, VIEWING_KEY, [
        BigInt(RECIPIENT_ADDR),
        BigInt(RECIPIENT_ADDR_2),
      ]);

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.recipients).toBeDefined();
      expect(requestBody.recipients).toHaveLength(2);

      expect(result.channels!.has(BigInt(RECIPIENT_ADDR))).toBe(true);
      expect(result.channels!.has(BigInt(RECIPIENT_ADDR_2))).toBe(true);
    });

    it("does not send recipients field for 'all' filter", async () => {
      const provider = createProvider();
      const fetchMock = mockFetchJson({
        body: outgoingSyncResponse(),
      });

      await provider.discoverChannels(USER_ADDRESS, VIEWING_KEY, "all");

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.recipients).toBeUndefined();
    });

    it("returns total from total_n_channels for 'total-only' recipients filter", async () => {
      const provider = createProvider();
      mockFetchJson({
        body: outgoingSyncResponse({
          cursor: {
            channel_discovery_complete: true,
            last_channel_index: 4,
            total_n_channels: 5,
          },
        }),
      });

      const result = await provider.discoverChannels(USER_ADDRESS, VIEWING_KEY, "total-only");

      expect(result.total).toBe(5);
      expect(result.channels).toBeUndefined();
    });

    it("returns total alongside channels for an explicit recipients filter", async () => {
      const provider = createProvider();
      mockFetchJson({
        body: outgoingSyncResponse({
          channels: [channelEntry(RECIPIENT_ADDR, PUBLIC_KEY_1, CHANNEL_KEY_1)],
          cursor: {
            channel_discovery_complete: true,
            total_n_channels: 9,
            channels: {
              [RECIPIENT_ADDR]: {
                channel_key: CHANNEL_KEY_1,
                subchannel_discovery_complete: true,
                subchannels: {},
              },
            },
          },
        }),
      });

      const result = await provider.discoverChannels(USER_ADDRESS, VIEWING_KEY, [
        BigInt(RECIPIENT_ADDR),
      ]);

      // The recipient walk reaches the sentinel, so the count comes back without
      // a separate total-only request.
      expect(result.total).toBe(9);
      expect(result.channels!.has(BigInt(RECIPIENT_ADDR))).toBe(true);
    });

    it("prefers real channels over precomputed channels for the same recipient", async () => {
      const provider = createProvider();
      const PRECOMPUTED_KEY = "0xdd1";
      const REAL_KEY = "0xee1";
      const PRECOMPUTED_PK = "0xff1";
      const REAL_PK = "0xff2";
      mockFetchJson({
        body: outgoingSyncResponse({
          channels: [
            channelEntry(RECIPIENT_ADDR, PRECOMPUTED_PK, PRECOMPUTED_KEY, { precomputed: true }),
            channelEntry(RECIPIENT_ADDR, REAL_PK, REAL_KEY),
          ],
          cursor: completeCursor({
            [RECIPIENT_ADDR]: { channel_key: REAL_KEY },
          }),
        }),
      });

      const result = await provider.discoverChannels(USER_ADDRESS, VIEWING_KEY, "all");

      const channel = result.channels!.get(BigInt(RECIPIENT_ADDR));
      expect(channel).toBeDefined();
      expect(channel!.key).toBe(BigInt(REAL_KEY));
      expect(channel!.publicKey).toBe(BigInt(REAL_PK));
    });
  });

  describe("discoverRequirement", () => {
    it.each([
      {
        name: "Register when sender not registered",
        response: { sender_registered: false, channel_exists: false, subchannel_exists: false },
        expected: SetupRequirement.Register,
      },
      {
        name: "SetupChannel when registered but no channel",
        response: { sender_registered: true, channel_exists: false, subchannel_exists: false },
        expected: SetupRequirement.SetupChannel,
      },
      {
        name: "SetupToken when channel exists but no subchannel",
        response: { sender_registered: true, channel_exists: true, subchannel_exists: false },
        expected: SetupRequirement.SetupToken,
      },
      {
        name: "Ready when everything exists",
        response: { sender_registered: true, channel_exists: true, subchannel_exists: true },
        expected: SetupRequirement.Ready,
      },
    ])("returns $expected for $name", async ({ response, expected }) => {
      const provider = createProvider();
      mockFetchJson({
        body: { block_ref: BLOCK_REF, ...response },
      });

      const result = await provider.discoverRequirement(
        USER_ADDRESS,
        VIEWING_KEY,
        BigInt(RECIPIENT_ADDR),
        BigInt(TOKEN_ADDR)
      );

      expect(result).toBe(expected);
    });
  });

  describe("request body validation", () => {
    it("includes contract_address and viewing_key in discoverNotes requests", async () => {
      const provider = createProvider();
      const fetchMock = mockFetchJson({ body: incomingSyncResponse() });

      await provider.discoverNotes(USER_ADDRESS, VIEWING_KEY);

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.contract_address).toBe("0x123");
      expect(requestBody.viewing_key).toBe("0xbeef");
      expect(requestBody.decryption_key).toBeUndefined();
    });

    it("includes contract_address and viewing_key in discoverChannels requests", async () => {
      const provider = createProvider();
      const fetchMock = mockFetchJson({ body: outgoingSyncResponse() });

      await provider.discoverChannels(USER_ADDRESS, VIEWING_KEY, "all");

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.contract_address).toBe("0x123");
      expect(requestBody.viewing_key).toBe("0xbeef");
      expect(requestBody.decryption_key).toBeUndefined();
    });

    it("includes contract_address and viewing_key in discoverRequirement requests", async () => {
      const provider = createProvider();
      const fetchMock = mockFetchJson({
        body: {
          block_ref: BLOCK_REF,
          sender_registered: true,
          channel_exists: true,
          subchannel_exists: true,
        },
      });

      await provider.discoverRequirement(
        USER_ADDRESS,
        VIEWING_KEY,
        BigInt(RECIPIENT_ADDR),
        BigInt(TOKEN_ADDR)
      );

      const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(requestBody.contract_address).toBe("0x123");
      expect(requestBody.viewing_key).toBe("0xbeef");
      expect(requestBody.decryption_key).toBeUndefined();
    });
  });

  describe("exported helpers", () => {
    it("round-trips notesCursorToApiCursor → apiCursorToNotesCursor", () => {
      const senderAddress = 0xabn;
      const tokenAddress = 0xcdn;
      const channelKey = 0x999n;

      const noteIndexes = new AddressMap<number>();
      noteIndexes.set(tokenAddress, 5);

      const totalNoteCounts = new AddressMap<number>();
      totalNoteCounts.set(tokenAddress, 10);

      const incomingChannels = new AddressMap<IncomingChannelCursor>();
      incomingChannels.set(senderAddress, {
        channelKey,
        subchannelIdIndex: 3,
        noteIndexes,
        totalNoteCounts,
      });

      const originalCursor: NotesCursor = {
        blockId: BLOCK_REF,
        incomingChannels,
      };

      const apiCursor = notesCursorToApiCursor(originalCursor, null);
      const roundTripped = apiCursorToNotesCursor(apiCursor, BLOCK_REF);

      expect(roundTripped.blockId).toBe(BLOCK_REF);

      const rtChannel = roundTripped.incomingChannels.get(senderAddress);
      expect(rtChannel).toBeDefined();
      expect(rtChannel!.channelKey).toBe(channelKey);
      expect(rtChannel!.subchannelIdIndex).toBe(3);
      expect(rtChannel!.noteIndexes.get(tokenAddress)).toBe(5);
      expect(rtChannel!.totalNoteCounts.get(tokenAddress)).toBe(10);
    });

    it("convertIncomingNotes filters by token", () => {
      const apiNotes = [
        noteEntry({ note_id: "0xe1", salt: "5" }),
        noteEntry({ token: TOKEN_ADDR_2, note_id: "0xe2", amount: "200", salt: "6" }),
      ];
      const channelKeyMap = new Map<string, bigint>([[SENDER_ADDR, 0xcc1n]]);
      const existingChannels = new AddressMap<IncomingChannelCursor>();
      const tokenFilter = new Set([BigInt(TOKEN_ADDR)]);

      const result = convertIncomingNotes(apiNotes, channelKeyMap, existingChannels, tokenFilter);

      const token1Notes = result.get(BigInt(TOKEN_ADDR));
      expect(token1Notes).toHaveLength(1);
      expect(token1Notes![0].id).toBe("0xe1");

      const token2Notes = result.get(BigInt(TOKEN_ADDR_2));
      expect(token2Notes ?? []).toHaveLength(0);
    });

    it("convertIncomingNotes throws when sender has no channel key", () => {
      const unknownSender = "0xdead";
      const apiNotes = [noteEntry({ sender_addr: unknownSender })];
      const channelKeyMap = new Map<string, bigint>();
      const existingChannels = new AddressMap<IncomingChannelCursor>();

      expect(() => convertIncomingNotes(apiNotes, channelKeyMap, existingChannels, null)).toThrow(
        `Missing channel_key for sender ${unknownSender}`
      );
    });

    describe("buildSubchannelCursors", () => {
      it("builds cursors from token-noteIndex pairs", () => {
        const entries: [bigint, number][] = [
          [BigInt(TOKEN_ADDR), 5],
          [BigInt(TOKEN_ADDR_2), 0],
        ];
        const result = buildSubchannelCursors(entries, null);

        expect(Object.keys(result)).toHaveLength(2);
        expect(result[TOKEN_ADDR]).toEqual({ last_note_index: 4 });
        expect(result[TOKEN_ADDR_2]).toEqual({ last_note_index: undefined });
      });

      it("filters by token when tokenFilter is provided", () => {
        const entries: [bigint, number][] = [
          [BigInt(TOKEN_ADDR), 3],
          [BigInt(TOKEN_ADDR_2), 7],
        ];
        const tokenFilter = new Set([BigInt(TOKEN_ADDR)]);
        const result = buildSubchannelCursors(entries, tokenFilter);

        expect(Object.keys(result)).toHaveLength(1);
        expect(result[TOKEN_ADDR]).toEqual({ last_note_index: 2 });
        expect(result[TOKEN_ADDR_2]).toBeUndefined();
      });

      it("returns empty record for empty input", () => {
        const result = buildSubchannelCursors([], null);
        expect(Object.keys(result)).toHaveLength(0);
      });
    });

    describe("notesCursorToApiCursor subchannel_discovery_complete", () => {
      it("sets subchannel_discovery_complete false when filtered token is missing from noteIndexes", () => {
        const senderAddress = 0xabn;
        const knownToken = BigInt(TOKEN_ADDR);
        const unknownToken = BigInt(TOKEN_ADDR_2);

        const noteIndexes = new AddressMap<number>();
        noteIndexes.set(knownToken, 3);

        const incomingChannels = new AddressMap<IncomingChannelCursor>();
        incomingChannels.set(senderAddress, {
          channelKey: 0x999n,
          subchannelIdIndex: 1,
          noteIndexes,
          totalNoteCounts: new AddressMap<number>(),
        });

        const cursor: NotesCursor = { blockId: BLOCK_REF, incomingChannels };
        const tokenFilter = new Set([knownToken, unknownToken]);

        const apiCursor = notesCursorToApiCursor(cursor, tokenFilter);
        const senderChannel = apiCursor.channels!["0xab"];

        expect(senderChannel.subchannel_discovery_complete).toBe(false);
      });

      it("sets subchannel_discovery_complete true when all filtered tokens exist in noteIndexes", () => {
        const senderAddress = 0xabn;
        const token1 = BigInt(TOKEN_ADDR);
        const token2 = BigInt(TOKEN_ADDR_2);

        const noteIndexes = new AddressMap<number>();
        noteIndexes.set(token1, 3);
        noteIndexes.set(token2, 1);

        const incomingChannels = new AddressMap<IncomingChannelCursor>();
        incomingChannels.set(senderAddress, {
          channelKey: 0x999n,
          subchannelIdIndex: 2,
          noteIndexes,
          totalNoteCounts: new AddressMap<number>(),
        });

        const cursor: NotesCursor = { blockId: BLOCK_REF, incomingChannels };
        const tokenFilter = new Set([token1, token2]);

        const apiCursor = notesCursorToApiCursor(cursor, tokenFilter);
        const senderChannel = apiCursor.channels!["0xab"];

        expect(senderChannel.subchannel_discovery_complete).toBe(true);
      });

      it("sets subchannel_discovery_complete false when tokenFilter is null", () => {
        const senderAddress = 0xabn;
        const noteIndexes = new AddressMap<number>();
        noteIndexes.set(BigInt(TOKEN_ADDR), 3);

        const incomingChannels = new AddressMap<IncomingChannelCursor>();
        incomingChannels.set(senderAddress, {
          channelKey: 0x999n,
          subchannelIdIndex: 1,
          noteIndexes,
          totalNoteCounts: new AddressMap<number>(),
        });

        const cursor: NotesCursor = { blockId: BLOCK_REF, incomingChannels };
        const apiCursor = notesCursorToApiCursor(cursor, null);
        const senderChannel = apiCursor.channels!["0xab"];

        expect(senderChannel.subchannel_discovery_complete).toBe(false);
      });
    });
  });
});
