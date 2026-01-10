import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { ERC20s, PrivacyPool, MockPrivateTransfers } from "../../src/testing/index.js";
import {
  withLogging,
  consoleLogCallback,
  debugHint,
  isDebugEnabled,
} from "../../src/utils/index.js";
import type { PrivateRecipient, Channel } from "../../src/interfaces.js";
import { open } from "../../src/interfaces.js";

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

  describe("registration", () => {
    it("user is not registered initially", async () => {
      expect(await alice.isRegistered()).toBe(false);
    });

    it("user becomes registered after register()", async () => {
      await alice.register();
      expect(await alice.isRegistered()).toBe(true);
    });

    it("multiple users can register independently", async () => {
      await alice.register();
      await bob.register();

      expect(await alice.isRegistered()).toBe(true);
      expect(await bob.isRegistered()).toBe(true);
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
      const setupResult = await alice.setupInitial(BOB_ADDRESS);
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
      const bobToAliceSetup = await bob.setupInitial(ALICE_ADDRESS);
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

  describe("builder pattern", () => {
    beforeEach(async () => {
      // Give Alice some public tokens
      erc20s.get(STRK).setBalance(ALICE_ADDRESS, 1000n);
      erc20s.get(ETH).setBalance(ALICE_ADDRESS, 500n);
    });

    it("example: register and setup a new recipient", async () => {
      // From interface docs:
      // const alice: PrivateRecipient = { address: ALICE_ADDRESS, context: undefined! };
      // await transfers.build()
      //   .register()
      //   .setup(alice)  // alice.context will be populated with the Channel
      //   .with(STRK)
      //     .setup(alice)
      //     .deposit(100n, alice)
      //   .execute();

      // First Bob needs to register so Alice can set up channel to him
      await bob.register();

      // Create recipient - context will be populated by setup()
      const bobRecipient: PrivateRecipient = {
        address: BOB_ADDRESS,
        context: undefined!,
      };

      // Use builder to register, setup channel, setup token, and deposit - all in one batch
      // prettier-ignore
      await alice
        .build()
        .register()
        .setup(bobRecipient) // populates bobRecipient.context with Channel
        .with(STRK)
          .setup(bobRecipient)
          .deposit(100n, bobRecipient)
        .execute();

      // Bob should have a note
      const bobNotes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotes.length).toBe(1);
      expect(bobNotes[0].amount).toBe(100n);
    });

    it("example: transfer to multiple recipients with multiple tokens", async () => {
      // From interface docs:
      // await transfers.build()
      //   .with(STRK)
      //     .inputs(strkNote)
      //     .transfer({ recipient: alice, amount: 10n })
      //   .with(ETH)
      //     .inputs(ethNote1, ethNote2)
      //     .transfer({ recipient: bob, amount: 20n })
      //   .execute();

      // Bob needs to be registered first so Alice can set up channel to him
      await bob.build().register().execute();

      // Create recipients - context will be populated by setup()
      const aliceSelf: PrivateRecipient = { address: ALICE_ADDRESS, context: undefined! };
      const bobRecipient: PrivateRecipient = { address: BOB_ADDRESS, context: undefined! };

      // Alice registers, sets up channels, tokens, and deposits - all via builder
      // prettier-ignore
      await alice
        .build()
        .register()
        .setup(aliceSelf) // channel to self for deposits
        .setup(bobRecipient) // channel to Bob for transfers
        .with(STRK)
          .setup(aliceSelf)
          .setup(bobRecipient)
          .deposit(100n, aliceSelf)
        .with(ETH)
          .setup(aliceSelf)
          .setup(bobRecipient)
          .deposit(50n, aliceSelf)
        .execute();

      // Alice discovers her notes
      const aliceNotes = alice.discoverNotes();
      const strkNote = (aliceNotes.notes.get(STRK) ?? [])[0];
      const ethNote = (aliceNotes.notes.get(ETH) ?? [])[0];

      expect(strkNote).toBeDefined();
      expect(ethNote).toBeDefined();

      // Now use builder to transfer to Bob (must use full amounts - no change support yet)
      // prettier-ignore
      await alice
        .build()
        .with(STRK)
          .inputs(strkNote)
          .transfer({ recipient: bobRecipient, amount: 100n }) // Full amount
        .with(ETH)
          .inputs(ethNote)
          .transfer({ recipient: bobRecipient, amount: 50n }) // Full amount
        .execute();

      // Bob should have notes
      const bobNotes = bob.discoverNotes();
      const bobStrkNotes = bobNotes.notes.get(STRK) ?? [];
      const bobEthNotes = bobNotes.notes.get(ETH) ?? [];

      expect(bobStrkNotes.length).toBe(1);
      expect(bobStrkNotes[0].amount).toBe(100n);
      expect(bobEthNotes.length).toBe(1);
      expect(bobEthNotes[0].amount).toBe(50n);
    });

    it("builder fails when input/output amounts don't match", async () => {
      // Setup: Alice deposits 100n STRK to herself
      const aliceSelf: PrivateRecipient = { address: ALICE_ADDRESS, context: undefined! };

      await alice
        .build()
        .register()
        .setup(aliceSelf)
        .with(STRK)
        .setup(aliceSelf)
        .deposit(100n, aliceSelf)
        .execute();

      // Get Alice's note
      const strkNote = (alice.discoverNotes().notes.get(STRK) ?? [])[0];
      expect(strkNote).toBeDefined();

      // Try to transfer only 50n (leaving 50n unaccounted for) - should fail
      await expect(
        alice.build().with(STRK).inputs(strkNote).withdraw({ amount: 50n }).execute()
      ).rejects.toThrow(/input\/output mismatch.*input=100.*output=50/);
    });

    it("builder: register, setup channel, and deposit in one batch", async () => {
      // Bob needs to be registered first
      await bob.register();

      // Create recipient - context will be populated by setup()
      const bobRecipient: PrivateRecipient = { address: BOB_ADDRESS, context: undefined! };

      // Alice does everything in one builder call
      const results = await alice.build().register().setup(bobRecipient).execute();

      expect(results.length).toBeGreaterThan(0);
      expect(await alice.isRegistered()).toBe(true);

      // Verify context was populated
      expect(bobRecipient.context).toBeDefined();

      // Verify channel was set up by discovering it
      const channels = alice.discoverChannels(BOB_ADDRESS);
      expect(channels.channels.has(BOB_ADDRESS)).toBe(true);
    });

    it("open notes: Bob creates open note, Alice deposits into it", async () => {
      // Both users register and set up channels
      const bobSelf: PrivateRecipient = { address: BOB_ADDRESS, context: undefined! };
      const aliceToBob: PrivateRecipient = { address: BOB_ADDRESS, context: undefined! };

      // prettier-ignore
      await bob
        .build()
        .register()
        .setup(bobSelf) // channel to self
        .with(STRK)
          .setup(bobSelf)
        .execute();

      // prettier-ignore
      await alice
        .build()
        .register()
        .setup(aliceToBob) // channel to Bob
        .with(STRK)
          .setup(aliceToBob)
        .execute();

      // Step 1: Bob creates an open note for himself
      // prettier-ignore
      await bob
        .build()
        .with(STRK)
          .transfer({ recipient: bobSelf, amount: open })
        .execute();

      // Bob discovers his open note
      const bobNotes = bob.discoverNotes();
      const openNotes = (bobNotes.notes.get(STRK) ?? []).filter((n) => n.open);
      expect(openNotes.length).toBe(1);
      expect(openNotes[0].open).toBe(true);

      const openNoteId = openNotes[0].id;

      // Step 2: Alice deposits into Bob's open note
      erc20s.get(STRK).setBalance(ALICE_ADDRESS, 1000n);

      // prettier-ignore
      await alice
        .build()
        .with(STRK)
          .deposit(100n, openNoteId) // deposit into the open note by ID
        .execute();

      // Bob should now have a filled note with the deposited amount
      const bobNotesAfter = bob.discoverNotes();
      const filledNotes = (bobNotesAfter.notes.get(STRK) ?? []).filter((n) => n.open);
      expect(filledNotes[0].amount).toBe(100n);
    });
  });
});
