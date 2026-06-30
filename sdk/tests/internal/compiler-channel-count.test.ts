import { describe, expect, it, vi, afterEach } from "vitest";
import { ActionCompiler } from "../../src/internal/compiler.js";
import { createEmptyRegistry, SetupRequirement } from "../../src/interfaces.js";
import type { DiscoveryProviderInterface, Note } from "../../src/interfaces.js";
import { AddressMap } from "../../src/utils/maps.js";
import { Channel } from "../../src/internal/channel.js";

const USER_ADDRESS = 0xa11cen;
const VIEWING_KEY = 0xbeefn;
const RECIPIENT_ADDR = 0xb0b1n;

/** A discovered-but-not-yet-opened channel: public key known, no channel key. */
function precomputedChannels() {
  return new AddressMap<Channel>([[RECIPIENT_ADDR, new Channel(0xaa2n)]]);
}

function baseProvider(): DiscoveryProviderInterface {
  return {
    discoverNotes: vi.fn().mockResolvedValue({
      timestamp: "0xblock",
      notes: new AddressMap<Note[]>(),
      cursor: { blockId: "0xblock", incomingChannels: new AddressMap() },
    }),
    discoverChannels: vi.fn(),
    discoverRequirement: vi.fn().mockResolvedValue(SetupRequirement.SetupChannel),
  };
}

function openChannelIndex(clientActions: { type: string; input: { index?: number } }[]) {
  return clientActions.find((action) => action.type === "OpenChannel")?.input.index;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActionCompiler outgoing channel count", () => {
  it("reuses the total from recipient discovery and skips the total-only query", async () => {
    const provider = baseProvider();
    provider.discoverChannels = vi.fn().mockResolvedValue({
      timestamp: "0xblock",
      channels: precomputedChannels(),
      total: 5,
    });
    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, provider);

    const result = await compiler.compile(
      { openChannels: [{ recipient: RECIPIENT_ADDR }] },
      { registry: createEmptyRegistry(), autoDiscover: { channels: "refresh" } }
    );

    // Single discovery round-trip: the recipient walk already carried the count.
    expect(provider.discoverChannels).toHaveBeenCalledOnce();
    // The reused count becomes the new channel's index.
    expect(openChannelIndex(result.clientActions)).toBe(5);
  });

  it("falls back to a total-only query when discovery returns no total", async () => {
    const provider = baseProvider();
    provider.discoverChannels = vi
      .fn()
      .mockResolvedValueOnce({ timestamp: "0xblock", channels: precomputedChannels() })
      .mockResolvedValueOnce({ timestamp: "0xblock", total: 7 });
    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, provider);

    const result = await compiler.compile(
      { openChannels: [{ recipient: RECIPIENT_ADDR }] },
      { registry: createEmptyRegistry(), autoDiscover: { channels: "refresh" } }
    );

    expect(provider.discoverChannels).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.discoverChannels).mock.calls[1][2]).toBe("total-only");
    expect(openChannelIndex(result.clientActions)).toBe(7);
  });
});
