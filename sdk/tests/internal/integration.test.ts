import { describe, expect, it, beforeEach, afterAll } from "vitest";
import {
  createTestEnv,
  createEmptyRegistry,
  AUTO_ALL,
  MockTestEnv,
  POOL_ADDRESS,
} from "../helpers/test-fixtures.js";
import { Open } from "../../src/interfaces.js";
import { debugHint, derivePublicKey, isDebugEnabled, toBigInt } from "../../src/utils/index.js";
import { compute_channel_key, compute_note_id } from "../../src/utils/hashes.js";
import { debugLog } from "../../src/utils/logging.js";
import { toHex } from "../../src/utils/convert.js";
import { MockSwapHelper } from "../../src/testing/contracts.js";

describe("Private Transfers Integration", () => {
  let testEnv: MockTestEnv;

  afterAll(() => {
    if (!isDebugEnabled()) {
      console.log(debugHint);
    }
  });

  beforeEach(() => {
    testEnv = createTestEnv();
  });

  // ============================================================================
  // Explicit Flow (no auto options)
  // ============================================================================
  describe("Explicit Flow", () => {
    it("manual registration, channel setup, token setup, deposit, transfer, withdraw", async () => {
      const { mocknet, env, transfers } = testEnv;
      const { alice, bob } = transfers;
      const ace = toBigInt(env.ace);

      // Bob registers separately (prerequisite for Alice to set up channel to him)
      mocknet.executeOutside(await bob.build().register().execute());

      // Alice: register, setup channels (self + Bob), setup token (self + Bob), deposit
      // prettier-ignore
      const registry = mocknet.executeOutside(
        await alice
          .build()
          .register()
          .setup(env.alice.address)
          .setup(env.bob.address)
          .with(env.ace)
            .setup(env.alice.address)
            .setup(env.bob.address)
            .deposit({ amount: 100n, recipient: env.alice.address })
          .execute()
      );

      debugLog("test", "registry", registry);

      // Get the deposited note
      const note = registry.notes.get(ace)![0];
      expect(note.amount).toBe(100n);

      // Alice: use note as input, transfer half to Bob, surplus to self, withdraw
      // prettier-ignore
      mocknet.executeOutside(
        await alice
          .build({ registry })
          .surplusTo(env.alice.address)
          .with(env.ace)
            .inputs(note)
            .transfer({ recipient: env.bob.address, amount: 50n })
            .withdraw({ amount: 25n })
          .execute()
      );

      // Alice should have 25n surplus note, Bob should have 50n note
      const aliceNotes = registry.notes.get(ace) ?? [];
      debugLog("test", "alice registry", registry);
      expect(aliceNotes.length).toBe(1);
      expect(aliceNotes[0].amount).toBe(25n);

      const bobNotes = (await bob.discoverNotes()).notes.get(ace) ?? [];
      expect(bobNotes.length).toBe(1);
      expect(bobNotes[0].amount).toBe(50n);

      // Bob withdraws his note
      // prettier-ignore
      mocknet.executeOutside(
        await bob
          .build({ autoDiscover: { channels: "refresh" } })
          .with(env.ace)
            .inputs(bobNotes[0])
            .withdraw({ amount: 50n })
          .execute()
      );

      expect(env.contracts.get(ace).balanceOf(env.alice.address)).toBe(925n); // 1000 - 100 + 25
      expect(env.contracts.get(ace).balanceOf(env.bob.address)).toBe(1050n); // 1000 + 50
    });
  });

  // ============================================================================
  // Auto Setup Flow
  // ============================================================================
  describe("Auto Setup Flow", () => {
    it("reuses next outgoing channel index after self deposit", async () => {
      const { mocknet, env, transfers } = testEnv;
      const { alice, bob } = transfers;
      const ace = toBigInt(env.ace);

      mocknet.executeOutside(await bob.build().register().execute());

      const registry = mocknet.executeOutside(
        await alice
          .build(AUTO_ALL)
          .with(env.ace)
          .deposit({ amount: 100n, recipient: env.alice.address })
          .execute()
      );

      mocknet.executeOutside(
        await alice
          .build({ ...AUTO_ALL, registry })
          .surplusTo(env.alice.address)
          .with(env.ace)
          .transfer({ recipient: env.bob.address, amount: 50n })
          .execute()
      );

      const bobNotes = (await bob.discoverNotes()).notes.get(ace) ?? [];
      expect(bobNotes.length).toBe(1);
      expect(bobNotes[0].amount).toBe(50n);
    });

    it("auto setup handles registration, channels, and token setup", async () => {
      const { mocknet, env, transfers } = testEnv;
      const { alice, bob } = transfers;
      const ace = toBigInt(env.ace);
      const bee = toBigInt(env.bee);

      // Bob registers (required for Alice to set up channel to him)
      mocknet.executeOutside(await bob.build().register().execute());

      // Alice uses autoRegister, autoSetup and autoSelectNotes: deposits and transfers to Bob
      // prettier-ignore
      const registry = mocknet.executeOutside(
        await alice
          .build(AUTO_ALL)
          .with(env.ace)
            .deposit({ amount: 100n, recipient: env.alice.address })
            .transfer({ recipient: env.bob.address, amount: 50n })
            .surplusTo(env.alice.address, true)
          .with(env.bee)
            .deposit({ amount: 100n })
            .transfer({ recipient: env.bob.address, amount: 50n })
            .transfer({ recipient: env.alice.address, amount: 50n })
          .execute()
      );

      expect(registry.notes.get(ace)?.length).toBe(0);
      expect(registry.notes.get(bee)?.length).toBe(1);

      const bobNotes = (await bob.discoverNotes()).notes;
      expect(bobNotes.get(ace)?.length).toBe(1);
      expect(bobNotes.get(ace)?.[0].amount).toBe(50n);
      expect(bobNotes.get(bee)?.length).toBe(1);
      expect(bobNotes.get(bee)?.[0].amount).toBe(50n);
    });

    it("covers autoSelectNotes: all, autoDiscover: missing, registryConst, implicit surplus", async () => {
      const { mocknet, env, transfers } = testEnv;
      const { alice } = transfers;
      const ace = toBigInt(env.ace);

      // Phase 1: Create multiple notes for Alice
      mocknet.executeOutside(await alice.build().register().execute());

      // Create first note: 100n
      mocknet.executeOutside(
        await alice
          .build(AUTO_ALL)
          .setup(env.alice.address)
          .with(env.ace)
          .deposit({ amount: 100n, recipient: env.alice.address })
          .execute()
      );

      // Create second note: 50n
      mocknet.executeOutside(
        await alice
          .build(AUTO_ALL)
          .with(env.ace)
          .deposit({ amount: 50n, recipient: env.alice.address })
          .execute()
      );

      // Phase 2: Use registry with channels but WITHOUT notes
      // This tests autoDiscover: "missing" (discovers notes not in registry)
      const channelOnly = createEmptyRegistry();
      const channel = (await alice.discoverChannels([env.alice.address])).channels.get(
        env.alice.address
      )!;
      channelOnly.channels.set(env.alice.address, channel);

      // Deposit 30n with:
      // - autoSelectNotes: "all" (sweeps ALL notes, not just enough for deficit)
      // - registryConst: true (don't mutate channelOnly)
      // - autoDiscover: { notes: "missing" } (discover ACE notes since not in registry)
      // - surplusTo triggers the "sweeping" code path for discovery
      debugLog("test", "main");
      const result = mocknet.executeOutside(
        await alice
          .build({
            registry: channelOnly,
            registryConst: true,
            autoDiscover: { channels: "refresh", notes: "missing" },
            autoSelectNotes: "all",
            autoSetup: true,
          })
          .surplusTo(env.alice.address) // Explicit surplus triggers sweeping discovery
          .with(env.ace)
          .deposit({ amount: 30n })
          .execute()
      );

      // Verify autoSelectNotes: "all" swept all notes into one
      // 100n + 50n (discovered & swept) + 30n (deposit) = 180n
      expect(result.notes.get(ace)?.length).toBe(1);
      expect(result.notes.get(ace)?.[0].amount).toBe(180n);

      // Verify registryConst: original registry unchanged
      expect(channelOnly.notes.has(ace)).toBe(false);

      // Verify ERC20 balance
      expect(env.contracts.get(ace).balanceOf(env.alice.address)).toBe(820n); // 1000 - 100 - 50 - 30
    });

    it("implicit surplus: deposit without surplusTo creates note for self", async () => {
      const { mocknet, env, transfers } = testEnv;
      const { alice, bob } = transfers;
      const ace = toBigInt(env.ace);

      mocknet.executeOutside(await alice.build().register().execute());

      // Deposit 100n, transfer only 30n to Bob -> 70n surplus with NO explicit surplusTo
      mocknet.executeOutside(await bob.build().register().execute());

      const result = mocknet.executeOutside(
        await alice
          .build(AUTO_ALL)
          .setup(env.alice.address)
          .setup(env.bob.address)
          .with(env.ace)
          .deposit({ amount: 100n }) // No recipient, no surplusTo
          .transfer({ recipient: env.bob.address, amount: 30n })
          .execute()
      );

      // Implicit surplus: 100n - 30n = 70n goes to self
      expect(result.notes.get(ace)?.length).toBe(1);
      expect(result.notes.get(ace)?.[0].amount).toBe(70n);

      // Bob got his 30n
      const bobNotes = (await bob.discoverNotes()).notes.get(ace) ?? [];
      expect(bobNotes.length).toBe(1);
      expect(bobNotes[0].amount).toBe(30n);

      expect(env.contracts.get(ace).balanceOf(env.alice.address)).toBe(900n); // 1000 - 100
    });
  });

  // ============================================================================
  // Swap Scenario (separate describe to use different setup)
  // ============================================================================
  const SWAP_HELPER_ADDRESS = "0x53A2";

  it("swaps ACE for BEE via swap helper and open note", async () => {
    const { mocknet, env, transfers } = testEnv;
    const { alice } = transfers;
    const ace = toBigInt(env.ace);
    const bee = toBigInt(env.bee);

    const swapHelper = new MockSwapHelper(SWAP_HELPER_ADDRESS, env.contracts);
    env.contracts.register(swapHelper);

    const key = compute_channel_key(
      env.alice.address,
      env.alice.privateKey,
      env.alice.address,
      derivePublicKey(env.alice.privateKey)
    );
    const beeNoteId = compute_note_id(key, bee, 0);

    // 1. Setup self-channel and deposit ACE (autoSetup handles token subchannel setup)
    // prettier-ignore
    mocknet.executeOutside(
      await alice
        .build(AUTO_ALL)
        .with(env.ace)
          .deposit({ amount: 100n, recipient: env.alice.address })
          .withdraw({ recipient: swapHelper.address, amount: 10n })
        .with(env.bee)
          .transfer({ recipient: env.alice.address, amount: Open, depositor: swapHelper.address })
        .done()
        .call({
          contractAddress: toHex(swapHelper.address),
          entrypoint: "swap",
          calldata: [ace, bee, 10n, POOL_ADDRESS, beeNoteId],
        })
        .execute()
    );

    // 4. Verify: Alice has 90n ACE change note
    const aceNotes = (await alice.discoverNotes()).notes.get(ace) ?? [];
    expect(aceNotes.length).toBe(1);
    expect(aceNotes[0].amount).toBe(90n);

    // Alice has 20n BEE note (swap helper gives 2x)
    const beeNotes = (await alice.discoverNotes()).notes.get(bee) ?? [];
    expect(beeNotes.length).toBe(1);
    expect(beeNotes[0].amount).toBe(20n);
    expect(beeNotes[0].open).toBe(true);
  });
});
