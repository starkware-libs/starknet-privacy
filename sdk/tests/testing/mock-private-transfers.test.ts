import { describe, expect, it, beforeEach, afterAll } from "vitest";
import {
  MockContracts,
  PrivacyPool,
  MockPrivateTransfers,
  applyStateChanges,
} from "../../src/testing/index.js";
import {
  withLogging,
  consoleLogCallback,
  debugHint,
  isDebugEnabled,
} from "../../src/utils/index.js";
import { Channel, createEmptyRegistry, SetupRequirement } from "../../src/interfaces.js";

// Test addresses and keys (must be valid hex addresses convertible to BigInt)
const POOL_ADDRESS = "0x1";
const STRK = "0x534752"; // Fake STRK token address
const ETH = "0x455448"; // Fake ETH token address

const ALICE_ADDRESS = "0xA11CE";
const ALICE_PRIVATE_KEY = 12345n;

const BOB_ADDRESS = "0xB0B";
const BOB_PRIVATE_KEY = 67890n;

// Default options for auto-discovery and auto-setup
const AUTO_OPTIONS = {
  autoDiscover: { recipient: "refresh" as const },
  autoSetup: true,
};

describe("MockPrivateTransfers", () => {
  let contracts: MockContracts;
  let pool: PrivacyPool;
  let alice: MockPrivateTransfers;
  let bob: MockPrivateTransfers;

  // Show debug hint after tests complete (only if debug is disabled)
  afterAll(() => {
    if (!isDebugEnabled()) {
      console.log(debugHint);
    }
  });

  beforeEach(() => {
    // Shared pool and MockContracts for all users
    contracts = new MockContracts();

    // Wrap pool with logging for debugging (logs only when SDK_DEBUG=1)
    pool = withLogging(new PrivacyPool(POOL_ADDRESS, contracts), "PrivacyPool", consoleLogCallback);
    contracts.register(pool);

    // Create transfers instances for each user
    alice = new MockPrivateTransfers(contracts, POOL_ADDRESS, ALICE_ADDRESS, ALICE_PRIVATE_KEY);
    bob = new MockPrivateTransfers(contracts, POOL_ADDRESS, BOB_ADDRESS, BOB_PRIVATE_KEY);
  });

  describe("discoverRequirement", () => {
    describe("discovering requirements for self", () => {
      it("returns Register when user is not registered", async () => {
        const req = await alice.discoverRequirement(ALICE_ADDRESS, STRK);
        expect(req).toBe(SetupRequirement.Register);
      });

      it("returns SetupChannel after registration (no channel to self)", async () => {
        applyStateChanges(await alice.build().register().execute());
        const req = await alice.discoverRequirement(ALICE_ADDRESS, STRK);
        expect(req).toBe(SetupRequirement.SetupChannel);
      });

      it("returns SetupToken after channel setup (no token)", async () => {
        applyStateChanges(await alice.build().register().execute());
        applyStateChanges(await alice.build().setup(ALICE_ADDRESS).execute());
        const req = await alice.discoverRequirement(ALICE_ADDRESS, STRK);
        expect(req).toBe(SetupRequirement.SetupToken);
      });

      it("returns Ready after token setup", async () => {
        applyStateChanges(await alice.build().register().execute());
        applyStateChanges(await alice.build().setup(ALICE_ADDRESS).execute());
        const channel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;

        const registry = createEmptyRegistry();
        registry.channels.set(ALICE_ADDRESS, channel);
        applyStateChanges(
          await alice.build({ registry }).with(STRK).setup(ALICE_ADDRESS).execute()
        );

        const req = await alice.discoverRequirement(ALICE_ADDRESS, STRK);
        expect(req).toBe(SetupRequirement.Ready);
      });
    });

    describe("discovering requirements for another user", () => {
      it("returns Register when recipient is not registered", async () => {
        applyStateChanges(await alice.build().register().execute());
        const req = await alice.discoverRequirement(BOB_ADDRESS, STRK);
        expect(req).toBe(SetupRequirement.Register);
      });

      it("returns SetupChannel when recipient is registered but no channel", async () => {
        applyStateChanges(await alice.build().register().execute());
        applyStateChanges(await bob.build().register().execute());
        const req = await alice.discoverRequirement(BOB_ADDRESS, STRK);
        expect(req).toBe(SetupRequirement.SetupChannel);
      });

      it("returns SetupToken when channel exists but token not set up", async () => {
        applyStateChanges(await alice.build().register().execute());
        applyStateChanges(await bob.build().register().execute());
        applyStateChanges(await alice.build().setup(BOB_ADDRESS).execute());
        const req = await alice.discoverRequirement(BOB_ADDRESS, STRK);
        expect(req).toBe(SetupRequirement.SetupToken);
      });

      it("returns Ready when fully set up", async () => {
        applyStateChanges(await alice.build().register().execute());
        applyStateChanges(await bob.build().register().execute());
        applyStateChanges(await alice.build().setup(BOB_ADDRESS).execute());
        const channel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

        const registry = createEmptyRegistry();
        registry.channels.set(BOB_ADDRESS, channel);
        applyStateChanges(await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute());

        const req = await alice.discoverRequirement(BOB_ADDRESS, STRK);
        expect(req).toBe(SetupRequirement.Ready);
      });

      it("different tokens require separate setup", async () => {
        applyStateChanges(await alice.build().register().execute());
        applyStateChanges(await bob.build().register().execute());
        applyStateChanges(await alice.build().setup(BOB_ADDRESS).execute());
        const channel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

        const registry = createEmptyRegistry();
        registry.channels.set(BOB_ADDRESS, channel);
        applyStateChanges(await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute());

        // STRK is ready, but ETH still needs setup
        expect(await alice.discoverRequirement(BOB_ADDRESS, STRK)).toBe(SetupRequirement.Ready);
        expect(await alice.discoverRequirement(BOB_ADDRESS, ETH)).toBe(SetupRequirement.SetupToken);
      });
    });

    describe("enum ordering (higher = more setup needed)", () => {
      it("Register > SetupChannel > SetupToken > Ready", () => {
        expect(SetupRequirement.Register).toBeGreaterThan(SetupRequirement.SetupChannel);
        expect(SetupRequirement.SetupChannel).toBeGreaterThan(SetupRequirement.SetupToken);
        expect(SetupRequirement.SetupToken).toBeGreaterThan(SetupRequirement.Ready);
      });
    });
  });

  describe("builder operations", () => {
    let aliceChannel: Channel;

    beforeEach(async () => {
      // Register both users
      applyStateChanges(await alice.build().register().execute());
      applyStateChanges(await bob.build().register().execute());

      // Alice sets up channel to Bob
      applyStateChanges(await alice.build().setup(BOB_ADDRESS).execute());
      aliceChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      // Setup token for Bob
      const registry = createEmptyRegistry();
      registry.channels.set(BOB_ADDRESS, aliceChannel);
      applyStateChanges(await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute());

      // Give Alice some public STRK to deposit
      contracts.get(STRK).setBalance(ALICE_ADDRESS, 1000n);
    });

    it("deposit creates a note for the recipient", async () => {
      applyStateChanges(
        await alice
          .build(AUTO_OPTIONS)
          .with(STRK)
          .deposit({ amount: 100n, recipient: BOB_ADDRESS })
          .execute()
      );

      // Bob should be able to discover the note
      const discovered = bob.discoverNotes();
      const notes = discovered.notes.get(STRK) ?? [];
      expect(notes.length).toBe(1);
      expect(notes[0].amount).toBe(100n);
    });

    it("withdraw converts private note back to public balance", async () => {
      // First deposit
      applyStateChanges(
        await alice
          .build(AUTO_OPTIONS)
          .with(STRK)
          .deposit({ amount: 100n, recipient: BOB_ADDRESS })
          .execute()
      );

      // Bob discovers his notes
      const discovered = bob.discoverNotes();
      const notes = discovered.notes.get(STRK) ?? [];
      expect(notes.length).toBe(1);

      // Bob withdraws
      applyStateChanges(
        await bob
          .build(AUTO_OPTIONS)
          .with(STRK)
          .inputs(...notes)
          .withdraw({ recipient: BOB_ADDRESS, amount: 100n })
          .execute()
      );

      // Bob should have public balance now
      expect(contracts.get(STRK).balanceOf(BOB_ADDRESS)).toBe(100n);
    });

    it("transfer moves note from one user to another", async () => {
      // Setup: Alice deposits to Bob
      applyStateChanges(
        await alice
          .build(AUTO_OPTIONS)
          .with(STRK)
          .deposit({ amount: 100n, recipient: BOB_ADDRESS })
          .execute()
      );

      // Bob discovers his notes
      const bobNotes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotes.length).toBe(1);

      // Bob needs to set up channel to Alice for transfer
      applyStateChanges(await bob.build().setup(ALICE_ADDRESS).execute());
      const bobToAliceChannel = bob.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;

      const bobRegistry = createEmptyRegistry();
      bobRegistry.channels.set(ALICE_ADDRESS, bobToAliceChannel);
      applyStateChanges(
        await bob.build({ registry: bobRegistry }).with(STRK).setup(ALICE_ADDRESS).execute()
      );

      // Bob transfers to Alice
      applyStateChanges(
        await bob
          .build(AUTO_OPTIONS)
          .with(STRK)
          .inputs(...bobNotes)
          .transfer({ recipient: ALICE_ADDRESS, amount: 100n })
          .execute()
      );

      // Alice should now have the note
      const aliceNotes = alice.discoverNotes().notes.get(STRK) ?? [];
      expect(aliceNotes.length).toBe(1);
      expect(aliceNotes[0].amount).toBe(100n);

      // Bob should have no notes left
      const bobNotesAfter = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotesAfter.length).toBe(0);
    });
  });

  describe("validation", () => {
    it("rejects negative deposit amounts", async () => {
      applyStateChanges(await alice.build().register().execute());
      applyStateChanges(await alice.build().setup(ALICE_ADDRESS).execute());
      const channel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(ALICE_ADDRESS, channel);
      applyStateChanges(await alice.build({ registry }).with(STRK).setup(ALICE_ADDRESS).execute());

      await expect(
        alice
          .build(AUTO_OPTIONS)
          .with(STRK)
          .deposit({ amount: -100n, recipient: ALICE_ADDRESS })
          .execute()
      ).rejects.toThrow(/Deposit amount must be non-negative/);
    });

    it("rejects negative withdraw amounts", async () => {
      applyStateChanges(await alice.build().register().execute());
      applyStateChanges(await bob.build().register().execute());
      applyStateChanges(await alice.build().setup(BOB_ADDRESS).execute());
      const channel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(BOB_ADDRESS, channel);
      applyStateChanges(await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute());

      contracts.get(STRK).setBalance(ALICE_ADDRESS, 1000n);
      applyStateChanges(
        await alice
          .build(AUTO_OPTIONS)
          .with(STRK)
          .deposit({ amount: 100n, recipient: BOB_ADDRESS })
          .execute()
      );

      const notes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(notes.length).toBe(1);

      await expect(
        bob
          .build(AUTO_OPTIONS)
          .with(STRK)
          .inputs(...notes)
          .withdraw({ amount: -50n })
          .execute()
      ).rejects.toThrow(/Withdraw amount must be non-negative/);
    });
  });
});
