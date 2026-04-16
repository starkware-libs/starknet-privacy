import { describe, expect, it, vi, afterEach } from "vitest";
import { ActionCompiler } from "../../src/internal/compiler.js";
import { ReorgError } from "../../src/internal/errors.js";
import { createEmptyRegistry, SetupRequirement } from "../../src/interfaces.js";
import type { DiscoveryProviderInterface, Note } from "../../src/interfaces.js";
import { AddressMap } from "../../src/utils/maps.js";
import { Channel } from "../../src/internal/channel.js";

const USER_ADDRESS = 0xa11cen;
const VIEWING_KEY = 0xbeefn;
const RECIPIENT_ADDR = 0xb0b1n;
const TOKEN_ADDR = 0xace1n;

function createMockProvider(overrides: Partial<DiscoveryProviderInterface> = {}) {
  return {
    discoverNotes: vi.fn().mockResolvedValue({
      timestamp: "0xblock",
      notes: new AddressMap<Note[]>(),
      cursor: { blockId: "0xblock", incomingChannels: new AddressMap() },
    }),
    discoverChannels: vi.fn().mockResolvedValue({
      timestamp: "0xblock",
      channels: new AddressMap<Channel>([
        [USER_ADDRESS, new Channel(0xaa1n, 0xcc1n)],
        [RECIPIENT_ADDR, new Channel(0xaa2n, 0xcc2n)],
      ]),
    }),
    discoverRequirement: vi.fn().mockResolvedValue(SetupRequirement.Ready),
    ...overrides,
  } satisfies DiscoveryProviderInterface;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActionCompiler reorg handling", () => {
  it("retries on ReorgError without mutating input registry", async () => {
    const mockProvider = createMockProvider({
      discoverChannels: vi
        .fn()
        .mockRejectedValueOnce(new ReorgError("block reorged"))
        .mockResolvedValue({
          timestamp: "0xblock2",
          channels: new AddressMap<Channel>([
            [USER_ADDRESS, new Channel(0xaa1n, 0xcc1n)],
            [RECIPIENT_ADDR, new Channel(0xaa2n, 0xcc2n)],
          ]),
        }),
    });

    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, mockProvider);

    const registry = createEmptyRegistry();
    registry.notes.set(TOKEN_ADDR, [
      {
        id: "0xstale",
        amount: 100n,
        witness: { channelKey: 0xc0n, nonce: 0, r: 1n },
        sender: 0xaaan,
      },
    ]);
    registry.channels.set(RECIPIENT_ADDR, new Channel(0xa1dn, 0xa1cn));
    registry.cursor = { blockId: "0xoldblock", incomingChannels: new AddressMap() };

    const result = await compiler.compile(
      { openChannels: [{ recipient: RECIPIENT_ADDR }] },
      { registry, autoDiscover: { channels: "refresh" } }
    );

    expect(mockProvider.discoverChannels).toHaveBeenCalledTimes(2);
    // Input registry is never mutated (immutability guarantee)
    expect(registry.notes.has(TOKEN_ADDR)).toBe(true);
    expect(registry.channels.has(RECIPIENT_ADDR)).toBe(true);
    expect(result.clientActions).toBeDefined();
  });

  it("propagates non-ReorgError without retry", async () => {
    const mockProvider = createMockProvider({
      discoverChannels: vi.fn().mockRejectedValue(new Error("network failure")),
    });

    const compiler = new ActionCompiler(USER_ADDRESS, VIEWING_KEY, mockProvider);

    await expect(
      compiler.compile(
        { openChannels: [{ recipient: RECIPIENT_ADDR }] },
        { registry: createEmptyRegistry(), autoDiscover: { channels: "refresh" } }
      )
    ).rejects.toThrow("network failure");

    expect(mockProvider.discoverChannels).toHaveBeenCalledOnce();
  });
});
