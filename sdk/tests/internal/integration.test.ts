import { describe, expect, it, beforeEach, afterAll } from "vitest";
import {
  createTestEnv,
  PrivateRegistry,
  AUTO_ALL,
  MockTestEnv,
  POOL_ADDRESS,
} from "../helpers/test-fixtures.js";
import { Open } from "../../src/interfaces.js";
import { cloneChannelCursor } from "../../src/internal/channel.js";
import { debugHint, isDebugEnabled, toBigInt } from "../../src/utils/index.js";
import { debugLog } from "../../src/utils/logging.js";
import { toHex } from "../../src/utils/convert.js";
import { MockSwapHelper } from "../../src/testing/contracts.js";
import { Mocknet } from "../../src/testing/mocknet.js";

describe("Private Transfers Integration", () => {
  let mocknet: Mocknet;
  let testEnv: MockTestEnv;

  afterAll(() => {
    if (!isDebugEnabled()) {
      console.log(debugHint);
    }
  });

  beforeEach(() => {
    testEnv = createTestEnv();
    mocknet = testEnv.mocknet;
  });

  // ============================================================================
  // Explicit Flow (no auto options)
  // ============================================================================
  describe("Explicit Flow", () => {
    it("manual registration, channel setup, token setup, deposit, transfer, withdraw", async () => {
      const { env, transfers } = testEnv;
      const { alice, bob } = transfers;
      const ace = toBigInt(env.ace);

      // Bob registers separately (prerequisite for Alice to set up channel to him)
      mocknet.executeOutside(await bob.build().register().execute());

      // Alice: register, setup channels (self + Bob), setup token (self + Bob), deposit
      const registry = new PrivateRegistry();
      // prettier-ignore
      mocknet.executeOutside(
        await alice
          .build({ registry })
          .register()
          .setup(env.alice.address)
          .setup(env.bob.address)
          .with(env.ace)
            .setup(env.alice.address)
            .setup(env.bob.address)
            .deposit({ amount: 100n, recipient: env.alice.address })
          .execute(),
        registry
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
          .execute(),
        registry
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
    it("auto setup handles registration, channels, and token setup", async () => {
      const { env, transfers } = testEnv;
      const { alice, bob } = transfers;
      const ace = toBigInt(env.ace);
      const bee = toBigInt(env.bee);

      // Bob registers (required for Alice to set up channel to him)
      mocknet.executeOutside(await bob.build().register().execute());

      // Alice uses autoRegister, autoSetup and autoSelectNotes: deposits and transfers to Bob
      // prettier-ignore
      const result = await alice
        .build(AUTO_ALL)
        .with(env.ace)
          .deposit({ amount: 100n })
          .transfer({ recipient: env.bob.address, amount: 50n })
          .surplusTo(env.alice.address, true)
        .with(env.bee)
          .deposit({ amount: 100n })
          .transfer({ recipient: env.bob.address, amount: 50n })
          .transfer({ recipient: env.alice.address, amount: 50n })
        .execute();
      mocknet.executeOutside(result);

      expect(result.registryUpdate.notes.get(ace)?.length ?? 0).toBe(0);
      expect(result.registryUpdate.notes.get(bee)?.length).toBe(1);

      const bobNotes = (await bob.discoverNotes()).notes;
      expect(bobNotes.get(ace)?.length).toBe(1);
      expect(bobNotes.get(ace)?.[0].amount).toBe(50n);
      expect(bobNotes.get(bee)?.length).toBe(1);
      expect(bobNotes.get(bee)?.[0].amount).toBe(50n);
    });

    it("covers autoSelectNotes: all, autoDiscover: missing, separate working registry, implicit surplus", async () => {
      const { env, transfers } = testEnv;
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
      // This tests autoDiscover: "missing" for notes (discovers notes not in registry)
      const channelOnly = new PrivateRegistry();
      await alice.discoverChannels({
        registry: channelOnly,
        level: "refresh",
        recipients: [env.alice.address],
      });

      // Create a separate working registry with the same channel cursor.
      // channelOnly is never passed to build() or executeOutside(), so it stays unchanged.
      const workingRegistry = new PrivateRegistry();
      workingRegistry.channelCursor = cloneChannelCursor(channelOnly.channelCursor!);

      // Deposit 30n with:
      // - autoSelectNotes: "all" (sweeps ALL notes, not just enough for deficit)
      // - autoDiscover: { notes: "missing" } (discover ACE notes since not in registry)
      // - surplusTo triggers the "sweeping" code path for discovery
      debugLog("test", "main");
      mocknet.executeOutside(
        await alice
          .build({
            registry: workingRegistry,
            autoDiscover: { channels: "refresh", notes: "missing" },
            autoSelectNotes: "all",
            autoSetup: true,
          })
          .surplusTo(env.alice.address) // Explicit surplus triggers sweeping discovery
          .with(env.ace)
          .deposit({ amount: 30n })
          .execute(),
        workingRegistry
      );

      // Verify autoSelectNotes: "all" swept all notes into one
      // 100n + 50n (discovered & swept) + 30n (deposit) = 180n
      expect(workingRegistry.notes.get(ace)?.length).toBe(1);
      expect(workingRegistry.notes.get(ace)?.[0].amount).toBe(180n);

      // Verify original registry is unchanged (never passed to build/executeOutside)
      expect(channelOnly.notes.has(ace)).toBe(false);

      // Verify ERC20 balance
      expect(env.contracts.get(ace).balanceOf(env.alice.address)).toBe(820n); // 1000 - 100 - 50 - 30
    });

    it("implicit surplus: deposit without surplusTo creates note for self", async () => {
      const { env, transfers } = testEnv;
      const { alice, bob } = transfers;
      const ace = toBigInt(env.ace);

      mocknet.executeOutside(await alice.build().register().execute());

      // Deposit 100n, transfer only 30n to Bob -> 70n surplus with NO explicit surplusTo
      mocknet.executeOutside(await bob.build().register().execute());

      const result = await alice
        .build(AUTO_ALL)
        .setup(env.alice.address)
        .setup(env.bob.address)
        .with(env.ace)
        .deposit({ amount: 100n }) // No recipient, no surplusTo
        .transfer({ recipient: env.bob.address, amount: 30n })
        .execute();
      mocknet.executeOutside(result);

      // Implicit surplus: 100n - 30n = 70n goes to self
      expect(result.registryUpdate.notes.get(ace)?.length).toBe(1);
      expect(result.registryUpdate.notes.get(ace)?.[0].amount).toBe(70n);

      // Bob got his 30n
      const bobNotes = (await bob.discoverNotes()).notes.get(ace) ?? [];
      expect(bobNotes.length).toBe(1);
      expect(bobNotes[0].amount).toBe(30n);

      expect(env.contracts.get(ace).balanceOf(env.alice.address)).toBe(900n); // 1000 - 100
    });

    it("channel index accounting: transfer to Bob, then Carol with registry, then David without registry", async () => {
      const { env, transfers } = testEnv;
      const { alice, bob, carol, david } = transfers;
      const ace = toBigInt(env.ace);

      // Register all users
      mocknet.executeOutside(await bob.build().register().execute());
      mocknet.executeOutside(await carol.build().register().execute());
      mocknet.executeOutside(await david.build().register().execute());

      // Alice deposits and transfers to Bob (creates outgoing channel index 0 to self, index 1 to Bob)
      const registryAfterBob = new PrivateRegistry();
      mocknet.executeOutside(
        await alice
          .build({ ...AUTO_ALL, registry: registryAfterBob })
          .with(env.ace)
          .deposit({ amount: 100n })
          .transfer({ recipient: env.bob.address, amount: 30n })
          .surplusTo(env.alice.address)
          .execute(),
        registryAfterBob
      );

      // Verify Bob got his transfer
      const bobNotes = (await bob.discoverNotes()).notes.get(ace) ?? [];
      expect(bobNotes.length).toBe(1);
      expect(bobNotes[0].amount).toBe(30n);

      // Alice transfers to Carol using the registry from step 1 (creates outgoing channel index 2 to Carol)
      mocknet.executeOutside(
        await alice
          .build({
            registry: registryAfterBob,
            autoDiscover: { channels: "refresh", notes: "refresh" },
            autoSetup: true,
            autoSelectNotes: "naive",
          })
          .with(env.ace)
          .transfer({ recipient: env.carol.address, amount: 20n })
          .surplusTo(env.alice.address)
          .execute(),
        registryAfterBob
      );

      // Verify Carol got her transfer
      const carolNotes = (await carol.discoverNotes()).notes.get(ace) ?? [];
      expect(carolNotes.length).toBe(1);
      expect(carolNotes[0].amount).toBe(20n);

      // Alice should have 50n remaining (100 - 30 - 20)
      expect(registryAfterBob.notes.get(ace)?.length).toBe(1);
      expect(registryAfterBob.notes.get(ace)?.[0].amount).toBe(50n);

      // Now transfer to David WITHOUT passing a registry (fresh discovery)
      // This tests that the channel index accounting is correct when discovering from scratch
      // and creating a new channel to a completely new recipient
      const finalRegistry = new PrivateRegistry();
      mocknet.executeOutside(
        await alice
          .build({ ...AUTO_ALL, registry: finalRegistry }) // Fresh discovery
          .with(env.ace)
          .transfer({ recipient: env.david.address, amount: 10n })
          .surplusTo(env.alice.address)
          .execute(),
        finalRegistry
      );

      // Verify David got his transfer
      const davidNotes = (await david.discoverNotes()).notes.get(ace) ?? [];
      expect(davidNotes.length).toBe(1);
      expect(davidNotes[0].amount).toBe(10n);

      // Alice should have 40n remaining (50 - 10)
      expect(finalRegistry.notes.get(ace)?.length).toBe(1);
      expect(finalRegistry.notes.get(ace)?.[0].amount).toBe(40n);

      // Final balance check
      expect(env.contracts.get(ace).balanceOf(env.alice.address)).toBe(900n); // 1000 - 100
    });
  });

  // ============================================================================
  // Deposit with explicit recipients
  // ============================================================================
  describe("Deposit with explicit recipients", () => {
    it("deposits to bob and carol in same token", async () => {
      const { env, transfers } = testEnv;
      const { alice, bob, carol } = transfers;
      const ace = toBigInt(env.ace);

      mocknet.executeOutside(await bob.build().register().execute());
      mocknet.executeOutside(await carol.build().register().execute());

      // prettier-ignore
      mocknet.executeOutside(
        await alice
          .build(AUTO_ALL)
          .with(env.ace)
            .deposit(
              { amount: 30n, recipient: env.bob.address },
              { amount: 50n, recipient: env.carol.address },
            )
          .execute()
      );

      const bobNotes = (await bob.discoverNotes()).notes.get(ace) ?? [];
      expect(bobNotes.length).toBe(1);
      expect(bobNotes[0].amount).toBe(30n);

      const carolNotes = (await carol.discoverNotes()).notes.get(ace) ?? [];
      expect(carolNotes.length).toBe(1);
      expect(carolNotes[0].amount).toBe(50n);

      expect(env.contracts.get(ace).balanceOf(env.alice.address)).toBe(920n); // 1000 - 30 - 50
    });

    it("deposits to bob in ACE and carol in BEE", async () => {
      const { env, transfers } = testEnv;
      const { alice, bob, carol } = transfers;
      const ace = toBigInt(env.ace);
      const bee = toBigInt(env.bee);

      mocknet.executeOutside(await bob.build().register().execute());
      mocknet.executeOutside(await carol.build().register().execute());

      // prettier-ignore
      mocknet.executeOutside(
        await alice
          .build(AUTO_ALL)
          .with(env.ace)
            .deposit({ amount: 40n, recipient: env.bob.address })
          .with(env.bee)
            .deposit({ amount: 60n, recipient: env.carol.address })
          .execute()
      );

      const bobAceNotes = (await bob.discoverNotes()).notes.get(ace) ?? [];
      expect(bobAceNotes.length).toBe(1);
      expect(bobAceNotes[0].amount).toBe(40n);

      const carolBeeNotes = (await carol.discoverNotes()).notes.get(bee) ?? [];
      expect(carolBeeNotes.length).toBe(1);
      expect(carolBeeNotes[0].amount).toBe(60n);

      expect(env.contracts.get(ace).balanceOf(env.alice.address)).toBe(960n); // 1000 - 40
      expect(env.contracts.get(bee).balanceOf(env.alice.address)).toBe(940n); // 1000 - 60
    });
  });

  // ============================================================================
  // Swap Scenario (separate describe to use different setup)
  // ============================================================================
  const SWAP_HELPER_ADDRESS = "0x53A2";

  it("swaps ACE for BEE via swap helper and open note", async () => {
    const { env, transfers } = testEnv;
    const { alice } = transfers;
    const ace = toBigInt(env.ace);
    const bee = toBigInt(env.bee);

    const swapHelper = new MockSwapHelper(SWAP_HELPER_ADDRESS, env.contracts, POOL_ADDRESS);
    env.contracts.register(swapHelper);

    // 1. Setup self-channel and deposit ACE (autoSetup handles token subchannel setup)
    // prettier-ignore
    mocknet.executeOutside(
      await alice
        .build(AUTO_ALL)
        .with(env.ace)
          .deposit({ amount: 100n })
          .withdraw({ recipient: swapHelper.address, amount: 10n })
        .with(env.bee)
          .transfer({ recipient: env.alice.address, amount: Open, depositor: swapHelper.address })
        .done()
        .invoke(({ openNotes }) => {
          expect(openNotes.length).toBe(1);
          expect(openNotes[0].token).toBe(bee);
          expect(openNotes[0].depositor).toBe(toBigInt(swapHelper.address));
          return {
            contractAddress: toHex(swapHelper.address),
            calldata: [ace, bee, 10n, openNotes[0].noteId],
          };
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
