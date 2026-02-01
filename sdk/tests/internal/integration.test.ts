import { describe, expect, it, beforeEach, afterAll } from "vitest";
import {
  createTestEnv,
  createEmptyRegistry,
  AUTO_ALL,
  ACE,
  BEE,
  ALICE,
  BOB,
  TestEnv,
  POOL_ADDRESS,
} from "../helpers/test-fixtures.js";
import { Open } from "../../src/interfaces.js";
import { debugHint, derivePublicKey, isDebugEnabled } from "../../src/utils/index.js";
import { compute_channel_key, compute_note_id } from "../../src/utils/hashes.js";
import { debugLog, hex } from "../../src/utils/logging.js";
import { MockSwapHelper } from "../../src/testing/contracts.js";

describe("Private Transfers Integration", () => {
  let env: TestEnv;

  afterAll(() => {
    if (!isDebugEnabled()) {
      console.log(debugHint);
    }
  });

  beforeEach(() => {
    env = createTestEnv();
  });

  // ============================================================================
  // Explicit Flow (no auto options)
  // ============================================================================
  describe("Explicit Flow", () => {
    it("manual registration, channel setup, token setup, deposit, transfer, withdraw", async () => {
      const { alice, bob, contracts, executeOutside } = env;

      // Bob registers separately (prerequisite for Alice to set up channel to him)
      executeOutside(await bob.build().register().execute());

      // Alice: register, setup channels (self + Bob), setup token (self + Bob), deposit
      // prettier-ignore
      const registry = executeOutside(
        await alice
          .build()
          .register()
          .setup(ALICE.address)
          .setup(BOB.address)
          .with(ACE)
            .setup(ALICE.address)
            .setup(BOB.address)
            .deposit({ amount: 100n, recipient: ALICE.address })
          .execute()
      );

      debugLog("test", "registry", registry);

      // Get the deposited note
      const note = registry.notes.get(ACE)![0];
      expect(note.amount).toBe(100n);

      // Alice: use note as input, transfer half to Bob, surplus to self, withdraw
      // prettier-ignore
      executeOutside(
        await alice
          .build({ registry })
          .surplusTo(ALICE.address)
          .with(ACE)
            .inputs(note)
            .transfer({ recipient: BOB.address, amount: 50n })
            .withdraw({ amount: 25n })
          .execute()
      );

      // Alice should have 25n surplus note, Bob should have 50n note
      const aliceNotes = registry.notes.get(ACE) ?? [];
      debugLog("test", "alice registry", registry);
      expect(aliceNotes.length).toBe(1);
      expect(aliceNotes[0].amount).toBe(25n);

      const bobNotes = (await bob.discoverNotes()).notes.get(ACE) ?? [];
      expect(bobNotes.length).toBe(1);
      expect(bobNotes[0].amount).toBe(50n);

      // Bob withdraws his note
      // prettier-ignore
      executeOutside(
        await bob
          .build({ autoDiscover: { channels: "refresh" } })
          .with(ACE)
            .inputs(bobNotes[0])
            .withdraw({ amount: 50n })
          .execute()
      );

      expect(contracts.get(ACE).balanceOf(ALICE.address)).toBe(925n); // 1000 - 100 + 25
      expect(contracts.get(ACE).balanceOf(BOB.address)).toBe(50n);
    });
  });

  // ============================================================================
  // Auto Setup Flow
  // ============================================================================
  describe("Auto Setup Flow", () => {
    it("auto setup handles registration, channels, and token setup", async () => {
      const { alice, bob, executeOutside } = env;

      // Bob registers (required for Alice to set up channel to him)
      executeOutside(await bob.build().register().execute());

      // Alice uses autoRegister, autoSetup and autoSelectNotes: deposits and transfers to Bob
      // prettier-ignore
      const registry = executeOutside(
        await alice
          .build(AUTO_ALL)
          .with(ACE)
            .deposit({ amount: 100n, recipient: ALICE.address })
            .transfer({ recipient: BOB.address, amount: 50n })
            .surplusTo(ALICE.address, true)
          .with(BEE)
            .deposit({ amount: 100n })
            .transfer({ recipient: BOB.address, amount: 50n })
            .transfer({ recipient: ALICE.address, amount: 50n })
          .execute()
      );

      expect(registry.notes.get(ACE)?.length).toBe(0);
      expect(registry.notes.get(BEE)?.length).toBe(1);

      const bobNotes = (await bob.discoverNotes()).notes;
      expect(bobNotes.get(ACE)?.length).toBe(1);
      expect(bobNotes.get(ACE)?.[0].amount).toBe(50n);
      expect(bobNotes.get(BEE)?.length).toBe(1);
      expect(bobNotes.get(BEE)?.[0].amount).toBe(50n);
    });

    it("covers autoSelectNotes: all, autoDiscover: missing, registryConst, implicit surplus", async () => {
      const { alice, contracts, executeOutside } = env;

      // Phase 1: Create multiple notes for Alice
      executeOutside(await alice.build().register().execute());

      // Create first note: 100n
      executeOutside(
        await alice
          .build(AUTO_ALL)
          .setup(ALICE.address)
          .with(ACE)
          .deposit({ amount: 100n, recipient: ALICE.address })
          .execute()
      );

      // Create second note: 50n
      executeOutside(
        await alice
          .build(AUTO_ALL)
          .with(ACE)
          .deposit({ amount: 50n, recipient: ALICE.address })
          .execute()
      );

      // Phase 2: Use registry with channels but WITHOUT notes
      // This tests autoDiscover: "missing" (discovers notes not in registry)
      const channelOnly = createEmptyRegistry();
      const channel = (await alice.discoverChannels([ALICE.address])).channels.get(ALICE.address)!;
      channelOnly.channels.set(ALICE.address, channel);

      // Deposit 30n with:
      // - autoSelectNotes: "all" (sweeps ALL notes, not just enough for deficit)
      // - registryConst: true (don't mutate channelOnly)
      // - autoDiscover: { notes: "missing" } (discover ACE notes since not in registry)
      // - surplusTo triggers the "sweeping" code path for discovery
      debugLog("test", "main");
      const result = executeOutside(
        await alice
          .build({
            registry: channelOnly,
            registryConst: true,
            autoDiscover: { channels: "refresh", notes: "missing" },
            autoSelectNotes: "all",
            autoSetup: true,
          })
          .surplusTo(ALICE.address) // Explicit surplus triggers sweeping discovery
          .with(ACE)
          .deposit({ amount: 30n })
          .execute()
      );

      // Verify autoSelectNotes: "all" swept all notes into one
      // 100n + 50n (discovered & swept) + 30n (deposit) = 180n
      expect(result.notes.get(ACE)?.length).toBe(1);
      expect(result.notes.get(ACE)?.[0].amount).toBe(180n);

      // Verify registryConst: original registry unchanged
      expect(channelOnly.notes.has(ACE)).toBe(false);

      // Verify ERC20 balance
      expect(contracts.get(ACE).balanceOf(ALICE.address)).toBe(820n); // 1000 - 100 - 50 - 30
    });

    it("implicit surplus: deposit without surplusTo creates note for self", async () => {
      const { alice, bob, contracts, executeOutside } = env;

      executeOutside(await alice.build().register().execute());

      // Deposit 100n, transfer only 30n to Bob -> 70n surplus with NO explicit surplusTo
      executeOutside(await bob.build().register().execute());

      const result = executeOutside(
        await alice
          .build(AUTO_ALL)
          .setup(ALICE.address)
          .setup(BOB.address)
          .with(ACE)
          .deposit({ amount: 100n }) // No recipient, no surplusTo
          .transfer({ recipient: BOB.address, amount: 30n })
          .execute()
      );

      // Implicit surplus: 100n - 30n = 70n goes to self
      expect(result.notes.get(ACE)?.length).toBe(1);
      expect(result.notes.get(ACE)?.[0].amount).toBe(70n);

      // Bob got his 30n
      const bobNotes = (await bob.discoverNotes()).notes.get(ACE) ?? [];
      expect(bobNotes.length).toBe(1);
      expect(bobNotes[0].amount).toBe(30n);

      expect(contracts.get(ACE).balanceOf(ALICE.address)).toBe(900n); // 1000 - 100
    });
  });

  // ============================================================================
  // Swap Scenario (separate describe to use different setup)
  // ============================================================================
  const SWAP_HELPER_ADDRESS = "0x53A2";

  it("swaps ACE for BEE via swap helper and open note", async () => {
    const { alice, contracts, executeOutside } = env;

    const swapHelper = new MockSwapHelper(SWAP_HELPER_ADDRESS, contracts);
    contracts.register(swapHelper);

    const key = compute_channel_key(
      ALICE.address,
      ALICE.privateKey,
      ALICE.address,
      derivePublicKey(ALICE.privateKey)
    );
    const beeNoteId = compute_note_id(key, BEE, 0);

    // 1. Setup self-channel and deposit ACE (autoSetup handles token subchannel setup)
    // prettier-ignore
    executeOutside(
      await alice
        .build(AUTO_ALL)
        .with(ACE)
          .deposit({ amount: 100n, recipient: ALICE.address })
          .withdraw({ recipient: swapHelper.address, amount: 10n })
        .with(BEE)
          .transfer({ recipient: ALICE.address, amount: Open, depositor: swapHelper.address })
        .done()
        .call({
          contractAddress: hex(swapHelper.address),
          entrypoint: "swap",
          calldata: [ACE, BEE, 10n, POOL_ADDRESS, beeNoteId],
        })
        .execute()
    );

    // 4. Verify: Alice has 90n ACE change note
    const aceNotes = (await alice.discoverNotes()).notes.get(ACE) ?? [];
    expect(aceNotes.length).toBe(1);
    expect(aceNotes[0].amount).toBe(90n);

    // Alice has 20n BEE note (swap helper gives 2x)
    const beeNotes = (await alice.discoverNotes()).notes.get(BEE) ?? [];
    expect(beeNotes.length).toBe(1);
    expect(beeNotes[0].amount).toBe(20n);
    expect(beeNotes[0].open).toBe(true);
  });
});
