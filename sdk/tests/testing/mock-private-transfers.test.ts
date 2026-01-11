import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { ERC20s, PrivacyPool, MockPrivateTransfers } from "../../src/testing/index.js";
import {
  withLogging,
  consoleLogCallback,
  debugHint,
  isDebugEnabled,
} from "../../src/utils/index.js";
import type { PrivateRecipient } from "../../src/interfaces.js";
import { Channel, SetupRequirement } from "../../src/interfaces.js";

// Test addresses and keys (must be valid hex addresses convertible to BigInt)
const POOL_ADDRESS = "0x1";
const STRK = "0x534752"; // Fake STRK token address
const ETH = "0x455448"; // Fake ETH token address

const ALICE_ADDRESS = "0xA11CE";
const ALICE_PRIVATE_KEY = 12345n;

const BOB_ADDRESS = "0xB0B";
const BOB_PRIVATE_KEY = 67890n;

describe("MockPrivateTransfers", () => {
  let erc20s: ERC20s;
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
    // Shared pool and ERC20s for all users
    erc20s = new ERC20s();
    // Wrap pool with logging for debugging (logs only when SDK_DEBUG=1)
    pool = withLogging(new PrivacyPool(POOL_ADDRESS, erc20s), "PrivacyPool", consoleLogCallback);

    // Create transfers instances for each user
    alice = new MockPrivateTransfers(pool, ALICE_ADDRESS, ALICE_PRIVATE_KEY);
    bob = new MockPrivateTransfers(pool, BOB_ADDRESS, BOB_PRIVATE_KEY);
  });

  describe("discoverRequirement", () => {
    // Helper to create a PrivateRecipient
    const recipient = (address: string): PrivateRecipient => ({
      address,
      context: undefined!,
    });

    describe("discovering requirements for self", () => {
      it("returns Register when user is not registered", async () => {
        const req = await alice.discoverRequirement(recipient(ALICE_ADDRESS), STRK);
        expect(req).toBe(SetupRequirement.Register);
      });

      it("returns SetupChannel after registration (no channel to self)", async () => {
        await alice.register();
        const req = await alice.discoverRequirement(recipient(ALICE_ADDRESS), STRK);
        expect(req).toBe(SetupRequirement.SetupChannel);
      });

      it("returns SetupToken after channel setup (no token)", async () => {
        await alice.register();
        await alice.setupChannel(ALICE_ADDRESS);
        const req = await alice.discoverRequirement(recipient(ALICE_ADDRESS), STRK);
        expect(req).toBe(SetupRequirement.SetupToken);
      });

      it("returns Ready after token setup", async () => {
        await alice.register();
        const { channel } = await alice.setupChannel(ALICE_ADDRESS);
        const aliceRecipient: PrivateRecipient = { address: ALICE_ADDRESS, context: channel };
        await alice.setupToken(aliceRecipient, STRK);
        const req = await alice.discoverRequirement(recipient(ALICE_ADDRESS), STRK);
        expect(req).toBe(SetupRequirement.Ready);
      });
    });

    describe("discovering requirements for another user", () => {
      it("returns Register when recipient is not registered", async () => {
        await alice.register();
        const req = await alice.discoverRequirement(recipient(BOB_ADDRESS), STRK);
        expect(req).toBe(SetupRequirement.Register);
      });

      it("returns SetupChannel when recipient is registered but no channel", async () => {
        await alice.register();
        await bob.register();
        const req = await alice.discoverRequirement(recipient(BOB_ADDRESS), STRK);
        expect(req).toBe(SetupRequirement.SetupChannel);
      });

      it("returns SetupToken when channel exists but token not set up", async () => {
        await alice.register();
        await bob.register();
        await alice.setupChannel(BOB_ADDRESS);
        const req = await alice.discoverRequirement(recipient(BOB_ADDRESS), STRK);
        expect(req).toBe(SetupRequirement.SetupToken);
      });

      it("returns Ready when fully set up", async () => {
        await alice.register();
        await bob.register();
        const { channel } = await alice.setupChannel(BOB_ADDRESS);
        const bobRecipient: PrivateRecipient = { address: BOB_ADDRESS, context: channel };
        await alice.setupToken(bobRecipient, STRK);
        const req = await alice.discoverRequirement(recipient(BOB_ADDRESS), STRK);
        expect(req).toBe(SetupRequirement.Ready);
      });

      it("different tokens require separate setup", async () => {
        await alice.register();
        await bob.register();
        const { channel } = await alice.setupChannel(BOB_ADDRESS);
        const bobRecipient: PrivateRecipient = { address: BOB_ADDRESS, context: channel };
        await alice.setupToken(bobRecipient, STRK);

        // STRK is ready, but ETH still needs setup
        expect(await alice.discoverRequirement(recipient(BOB_ADDRESS), STRK)).toBe(
          SetupRequirement.Ready
        );
        expect(await alice.discoverRequirement(recipient(BOB_ADDRESS), ETH)).toBe(
          SetupRequirement.SetupToken
        );
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

  describe("direct methods", () => {
    let aliceChannel: Channel;
    let bobRecipient: PrivateRecipient;

    beforeEach(async () => {
      // Register both users
      await alice.register();
      await bob.register();

      // Alice sets up channel to Bob
      const setupResult = await alice.setupChannel(BOB_ADDRESS);
      aliceChannel = setupResult.channel;

      bobRecipient = {
        address: BOB_ADDRESS,
        context: aliceChannel,
      };

      // Setup token for Bob
      await alice.setupToken(bobRecipient, STRK);

      // Give Alice some public STRK to deposit
      erc20s.get(STRK).setBalance(ALICE_ADDRESS, 1000n);
    });

    it("deposit creates a note for the recipient", async () => {
      await alice.deposit({
        token: STRK,
        amount: 100n,
        recipient: bobRecipient,
      });

      // Bob should be able to discover the note
      const discovered = bob.discoverNotes();
      const notes = discovered.notes.get(STRK) ?? [];
      expect(notes.length).toBe(1);
      expect(notes[0].amount).toBe(100n);
    });

    it("withdraw converts private note back to public balance", async () => {
      // First deposit
      await alice.deposit({
        token: STRK,
        amount: 100n,
        recipient: bobRecipient,
      });

      // Bob discovers his notes
      const discovered = bob.discoverNotes();
      const notes = discovered.notes.get(STRK) ?? [];
      expect(notes.length).toBe(1);

      // Bob withdraws
      await bob.withdraw({
        token: STRK,
        inputs: notes,
        recipient: BOB_ADDRESS,
        amount: 100n,
      });

      // Bob should have public balance now
      expect(erc20s.get(STRK).balanceOf(BOB_ADDRESS)).toBe(100n);
    });

    it("transfer moves note from one user to another", async () => {
      // Setup: Alice deposits to Bob
      await alice.deposit({
        token: STRK,
        amount: 100n,
        recipient: bobRecipient,
      });

      // Bob discovers his notes
      const bobNotes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotes.length).toBe(1);

      // Bob needs to set up channel to Alice for transfer
      const bobToAliceSetup = await bob.setupChannel(ALICE_ADDRESS);
      const bobToAliceChannel = bobToAliceSetup.channel;
      const aliceRecipient: PrivateRecipient = {
        address: ALICE_ADDRESS,
        context: bobToAliceChannel,
      };
      await bob.setupToken(aliceRecipient, STRK);

      // Bob transfers to Alice
      await bob.transfer({
        token: STRK,
        inputs: bobNotes,
        recipient: aliceRecipient,
        amount: 100n,
      });

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
      await alice.register();
      const { channel } = await alice.setupChannel(ALICE_ADDRESS);
      const aliceSelf = { address: ALICE_ADDRESS, context: channel };
      await alice.setupToken(aliceSelf, STRK);

      await expect(
        alice.deposit({ token: STRK, amount: -100n, recipient: aliceSelf })
      ).rejects.toThrow(/Deposit amount must be non-negative/);
    });

    it("rejects negative withdraw amounts", async () => {
      await alice.register();
      await bob.register();
      const { channel } = await alice.setupChannel(BOB_ADDRESS);
      const bobRecipient = { address: BOB_ADDRESS, context: channel };
      await alice.setupToken(bobRecipient, STRK);

      erc20s.get(STRK).setBalance(ALICE_ADDRESS, 1000n);
      await alice.deposit({ token: STRK, amount: 100n, recipient: bobRecipient });

      const notes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(notes.length).toBe(1);

      await expect(bob.withdraw({ token: STRK, inputs: notes, amount: -50n })).rejects.toThrow(
        /Withdraw amount must be non-negative/
      );
    });
  });
});
