import { describe, expect, it, vi, afterEach } from "vitest";
import { ActionCompiler } from "../../src/internal/compiler.js";
import { createEmptyRegistry, SetupRequirement, WarningCode } from "../../src/interfaces.js";
import type { DiscoveryProviderInterface, Note } from "../../src/interfaces.js";
import { AddressMap } from "../../src/utils/maps.js";
import { Channel } from "../../src/internal/channel.js";

const USER_ADDRESS = 0xa11cen;
const VIEWING_KEY = 0xbeefn;
const RECIPIENT_ADDR = 0xb0b1n;
const RECIPIENT_ADDR_2 = 0xb0b2n;
const TOKEN_ADDR = 0xace1n;
const WITHDRAW_RECIPIENT = 0xa1d1n;

function createMockProvider(): DiscoveryProviderInterface {
  return {
    discoverNotes: vi.fn().mockResolvedValue({
      timestamp: "0xblock",
      notes: new AddressMap<Note[]>(),
      cursor: { blockId: "0xblock", incomingChannels: new AddressMap() },
    }),
    discoverChannels: vi.fn().mockResolvedValue({
      timestamp: "0xblock",
      channels: new AddressMap<Channel>([
        // User self-channel: ready, with the token already set up so withdraws can spend notes
        [
          USER_ADDRESS,
          new Channel(0xaa1n, 0xcc1n, [[TOKEN_ADDR, { tokenIndex: 0, noteNonce: 0 }]]),
        ],
        // Recipients with public key but no channel key (forces OpenChannel)
        [RECIPIENT_ADDR, new Channel(0xaa2n)],
        [RECIPIENT_ADDR_2, new Channel(0xaa3n)],
      ]),
    }),
    discoverRequirement: vi.fn().mockResolvedValue(SetupRequirement.Ready),
  };
}

function makeNote(): Note {
  return {
    id: "0x101",
    amount: 100n,
    witness: { channelKey: 0xcc1n, nonce: 0, r: 1n },
    sender: USER_ADDRESS,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActionCompiler privacy warnings (USER_LINKAGE)", () => {
  it("emits no warning for a single open channel", async () => {
    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, createMockProvider());

    const result = await compiler.compile(
      { openChannels: [{ recipient: RECIPIENT_ADDR }] },
      { registry: createEmptyRegistry(), autoDiscover: { channels: "refresh" } }
    );

    expect(result.warnings).toEqual([]);
  });

  it("emits USER_LINKAGE for multiple open channels with distinct recipients", async () => {
    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, createMockProvider());

    const result = await compiler.compile(
      {
        openChannels: [{ recipient: RECIPIENT_ADDR }, { recipient: RECIPIENT_ADDR_2 }],
      },
      { registry: createEmptyRegistry(), autoDiscover: { channels: "refresh" } }
    );

    expect(result.warnings.map((w) => w.code)).toEqual([WarningCode.USER_LINKAGE]);
  });

  it("emits USER_LINKAGE when withdraw recipient differs from open channel recipient", async () => {
    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, createMockProvider());

    const result = await compiler.compile(
      {
        openChannels: [{ recipient: RECIPIENT_ADDR }],
        useNotes: [{ token: TOKEN_ADDR, note: makeNote() }],
        withdraws: [{ recipient: WITHDRAW_RECIPIENT, token: TOKEN_ADDR, amount: 50n }],
      },
      { registry: createEmptyRegistry(), autoDiscover: { channels: "refresh" } }
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toEqual(WarningCode.USER_LINKAGE);
    expect(new Set(result.warnings[0].context.addresses)).toEqual(
      new Set([RECIPIENT_ADDR, WITHDRAW_RECIPIENT])
    );
  });

  it("does NOT emit USER_LINKAGE when withdraw recipient equals open channel recipient", async () => {
    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, createMockProvider());

    const result = await compiler.compile(
      {
        openChannels: [{ recipient: RECIPIENT_ADDR }],
        useNotes: [{ token: TOKEN_ADDR, note: makeNote() }],
        withdraws: [{ recipient: RECIPIENT_ADDR, token: TOKEN_ADDR, amount: 50n }],
      },
      { registry: createEmptyRegistry(), autoDiscover: { channels: "refresh" } }
    );

    expect(result.warnings).toEqual([]);
  });

  it("emits USER_LINKAGE with the user's address in context when deposit is paired with open channel", async () => {
    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, createMockProvider());

    const result = await compiler.compile(
      {
        openChannels: [{ recipient: RECIPIENT_ADDR }],
        deposits: [{ token: TOKEN_ADDR, amount: 100n }],
      },
      { registry: createEmptyRegistry(), autoDiscover: { channels: "refresh" } }
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toEqual(WarningCode.USER_LINKAGE);
    expect(new Set(result.warnings[0].context.addresses)).toEqual(
      new Set([RECIPIENT_ADDR, USER_ADDRESS])
    );
  });

  it("allows callers to suppress the warning by filtering known public addresses (e.g. paymaster) from context", async () => {
    // Simulates a wallet integration where withdrawals to a known paymaster
    // forwarder should not be considered a privacy leak.
    const PAYMASTER = 0xfeen;
    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, createMockProvider());

    const result = await compiler.compile(
      {
        openChannels: [{ recipient: RECIPIENT_ADDR }],
        useNotes: [{ token: TOKEN_ADDR, note: makeNote() }],
        withdraws: [{ recipient: PAYMASTER, token: TOKEN_ADDR, amount: 5n }],
      },
      { registry: createEmptyRegistry(), autoDiscover: { channels: "refresh" } }
    );

    // SDK still emits the warning — the paymaster is a real on-chain link.
    expect(result.warnings).toHaveLength(1);
    // Wallet-side: filter known public addresses, then re-evaluate.
    const knownPublicAddresses = new Set([PAYMASTER]);
    const remaining = result.warnings[0].context.addresses.filter(
      (address) => !knownPublicAddresses.has(address)
    );
    expect(remaining).toEqual([RECIPIENT_ADDR]);
    // Only one address left after filtering → wallet treats this as benign.
  });

  it("does NOT emit USER_LINKAGE when deposit is paired with self-channel (open channel to user)", async () => {
    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, createMockProvider());

    const result = await compiler.compile(
      {
        openChannels: [{ recipient: USER_ADDRESS }],
        deposits: [{ token: TOKEN_ADDR, amount: 100n }],
      },
      { registry: createEmptyRegistry(), autoDiscover: { channels: "refresh" } }
    );

    expect(result.warnings).toEqual([]);
  });

  it("emits USER_LINKAGE for deposit + withdraw to a different address (no open channel)", async () => {
    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, createMockProvider());

    const result = await compiler.compile(
      {
        useNotes: [{ token: TOKEN_ADDR, note: makeNote() }],
        deposits: [{ token: TOKEN_ADDR, amount: 100n }],
        withdraws: [{ recipient: WITHDRAW_RECIPIENT, token: TOKEN_ADDR, amount: 50n }],
      },
      { registry: createEmptyRegistry(), autoDiscover: { channels: "refresh" } }
    );

    expect(result.warnings.map((w) => w.code)).toEqual([WarningCode.USER_LINKAGE]);
  });

  it("does NOT emit USER_LINKAGE for deposit + withdraw to the user's own address", async () => {
    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, createMockProvider());

    const result = await compiler.compile(
      {
        useNotes: [{ token: TOKEN_ADDR, note: makeNote() }],
        deposits: [{ token: TOKEN_ADDR, amount: 100n }],
        withdraws: [{ recipient: USER_ADDRESS, token: TOKEN_ADDR, amount: 50n }],
      },
      { registry: createEmptyRegistry(), autoDiscover: { channels: "refresh" } }
    );

    expect(result.warnings).toEqual([]);
  });

  it("emits a single USER_LINKAGE even when multiple linkage sources are present", async () => {
    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, createMockProvider());

    const result = await compiler.compile(
      {
        openChannels: [{ recipient: RECIPIENT_ADDR }, { recipient: RECIPIENT_ADDR_2 }],
        useNotes: [{ token: TOKEN_ADDR, note: makeNote() }],
        deposits: [{ token: TOKEN_ADDR, amount: 100n }],
        withdraws: [{ recipient: WITHDRAW_RECIPIENT, token: TOKEN_ADDR, amount: 50n }],
      },
      { registry: createEmptyRegistry(), autoDiscover: { channels: "refresh" } }
    );

    expect(result.warnings.map((w) => w.code)).toEqual([WarningCode.USER_LINKAGE]);
  });
});
