import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { ERC20s, PrivacyPool, MockPrivateTransfers } from "../../src/testing/index.js";
import {
  withLogging,
  consoleLogCallback,
  debugHint,
  isDebugEnabled,
} from "../../src/utils/index.js";
import { Channel, createEmptyRegistry, open, SetupRequirement } from "../../src/interfaces.js";

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

describe("PrivateTransfersBuilder", () => {
  let erc20s: ERC20s;
  let pool: PrivacyPool;
  let alice: MockPrivateTransfers;
  let bob: MockPrivateTransfers;

  // Store channels for context
  let aliceSelfChannel: Channel;
  let aliceToBobChannel: Channel;
  let bobSelfChannel: Channel;

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

    // Give Alice some public tokens
    erc20s.get(STRK).setBalance(ALICE_ADDRESS, 1000n);
    erc20s.get(ETH).setBalance(ALICE_ADDRESS, 500n);
  });

  it("example: register and setup a new recipient", async () => {
    // First Bob needs to register so Alice can set up channel to him
    await bob.build().register().execute();

    // Alice registers and sets up channel to Bob
    await alice.build().register().execute();
    await alice.build().setup(BOB_ADDRESS).execute();
    aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

    // Setup token
    const registry = createEmptyRegistry();
    registry.channels.set(BOB_ADDRESS, aliceToBobChannel);
    await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute();

    // Use builder to deposit
    // prettier-ignore
    await alice
      .build(AUTO_OPTIONS)
      .with(STRK)
        .deposit(100n, BOB_ADDRESS)
      .execute();

    // Bob should have a note
    const bobNotes = bob.discoverNotes().notes.get(STRK) ?? [];
    expect(bobNotes.length).toBe(1);
    expect(bobNotes[0].amount).toBe(100n);
  });

  it("example: transfer to multiple recipients with multiple tokens", async () => {
    // Both users register first
    await bob.build().register().execute();
    await alice.build().register().execute();

    // Alice sets up channels
    await alice.build().setup(ALICE_ADDRESS).setup(BOB_ADDRESS).execute();
    aliceSelfChannel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;
    aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

    // Setup tokens
    const registry = createEmptyRegistry();
    registry.channels.set(ALICE_ADDRESS, aliceSelfChannel);
    registry.channels.set(BOB_ADDRESS, aliceToBobChannel);

    await alice
      .build({ registry })
      .with(STRK)
      .setup(ALICE_ADDRESS)
      .setup(BOB_ADDRESS)
      .with(ETH)
      .setup(ALICE_ADDRESS)
      .setup(BOB_ADDRESS)
      .execute();

    // Deposit to self
    // prettier-ignore
    await alice
      .build(AUTO_OPTIONS)
      .with(STRK)
        .deposit(100n, ALICE_ADDRESS)
      .with(ETH)
        .deposit(50n, ALICE_ADDRESS)
      .execute();

    // Alice discovers her notes
    const aliceNotes = alice.discoverNotes();
    const strkNote = (aliceNotes.notes.get(STRK) ?? [])[0];
    const ethNote = (aliceNotes.notes.get(ETH) ?? [])[0];

    expect(strkNote).toBeDefined();
    expect(ethNote).toBeDefined();

    // Now use builder to transfer to Bob (must use full amounts)
    // prettier-ignore
    await alice
      .build(AUTO_OPTIONS)
      .with(STRK)
        .inputs(strkNote)
        .transfer({ recipient: BOB_ADDRESS, amount: 100n })
      .with(ETH)
        .inputs(ethNote)
        .transfer({ recipient: BOB_ADDRESS, amount: 50n })
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
    // Setup: Alice registers and deposits 100n STRK to herself
    await alice.build().register().execute();

    await alice.build().setup(ALICE_ADDRESS).execute();
    aliceSelfChannel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;

    const registry = createEmptyRegistry();
    registry.channels.set(ALICE_ADDRESS, aliceSelfChannel);
    await alice.build({ registry }).with(STRK).setup(ALICE_ADDRESS).execute();

    await alice.build(AUTO_OPTIONS).with(STRK).deposit(100n, ALICE_ADDRESS).execute();

    // Get Alice's note
    const strkNote = (alice.discoverNotes().notes.get(STRK) ?? [])[0];
    expect(strkNote).toBeDefined();

    // Try to transfer only 50n (leaving 50n unaccounted for) - should fail
    // Pool validates that final total per token is 0 (input 100n - output 50n = 50n != 0)
    await expect(
      alice.build(AUTO_OPTIONS).with(STRK).inputs(strkNote).withdraw({ amount: 50n }).execute()
    ).rejects.toThrow(/Final total for token.*is 50.*expected 0/);
  });

  it("builder: register, setup channel, and deposit in one batch", async () => {
    // Bob needs to be registered first
    await bob.build().register().execute();

    // Alice does everything in one builder call
    const result = await alice.build().register().setup(BOB_ADDRESS).execute();

    expect(result).toBeDefined();
    // Verify Alice is registered (not requiring Register)
    const aliceReq = await alice.discoverRequirement(ALICE_ADDRESS, "0x0");
    expect(aliceReq).not.toBe(SetupRequirement.Register);

    // Verify channel was set up by discovering it
    const channels = alice.discoverChannels(BOB_ADDRESS);
    expect(channels.channels.has(BOB_ADDRESS)).toBe(true);
  });

  it("open notes: Bob creates open note, Alice deposits into it", async () => {
    // Both users register
    await bob.build().register().execute();
    await alice.build().register().execute();

    // Setup Bob's self channel
    await bob.build().setup(BOB_ADDRESS).execute();
    bobSelfChannel = bob.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

    const bobRegistry = createEmptyRegistry();
    bobRegistry.channels.set(BOB_ADDRESS, bobSelfChannel);
    await bob.build({ registry: bobRegistry }).with(STRK).setup(BOB_ADDRESS).execute();

    // Setup Alice -> Bob channel
    await alice.build().setup(BOB_ADDRESS).execute();
    aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

    const aliceRegistry = createEmptyRegistry();
    aliceRegistry.channels.set(BOB_ADDRESS, aliceToBobChannel);
    await alice.build({ registry: aliceRegistry }).with(STRK).setup(BOB_ADDRESS).execute();

    // Step 1: Bob creates an open note for himself
    // prettier-ignore
    await bob
      .build(AUTO_OPTIONS)
      .with(STRK)
        .transfer({ recipient: BOB_ADDRESS, amount: open })
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
      .build(AUTO_OPTIONS)
      .with(STRK)
        .deposit(100n, openNoteId) // deposit into the open note by ID
      .execute();

    // Bob should now have a filled note with the deposited amount
    const bobNotesAfter = bob.discoverNotes();
    const filledNotes = (bobNotesAfter.notes.get(STRK) ?? []).filter((n) => n.open);
    expect(filledNotes[0].amount).toBe(100n);
  });

  describe("surplusTo", () => {
    beforeEach(async () => {
      // Setup: register Alice and set up channel to self
      await alice.build().register().execute();

      await alice.build().setup(ALICE_ADDRESS).execute();
      aliceSelfChannel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(ALICE_ADDRESS, aliceSelfChannel);
      await alice
        .build({ registry })
        .with(STRK)
        .setup(ALICE_ADDRESS)
        .with(ETH)
        .setup(ALICE_ADDRESS)
        .execute();
    });

    it("surplusTo on root builder: creates surplus note for all tokens", async () => {
      // Deposit 100 STRK to Alice (she starts with 1000n public)
      // prettier-ignore
      await alice
        .build(AUTO_OPTIONS)
        .with(STRK)
          .deposit(100n, ALICE_ADDRESS)
        .execute();

      // After deposit: 900n public, 100n private
      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(900n);
      const note = (alice.discoverNotes().notes.get(STRK) ?? [])[0];
      expect(note.amount).toBe(100n);

      // Use the 100n note but only withdraw 30n - surplus of 70n should go to self
      // prettier-ignore
      await alice
        .build(AUTO_OPTIONS)
        .surplusTo(ALICE_ADDRESS)
        .with(STRK)
          .inputs(note)
          .withdraw({ amount: 30n })
        .execute();

      // After: 930n public (900 + 30), 70n private (surplus note)
      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(930n);

      // Alice should have a new note with 70n (the surplus)
      const notesAfter = alice.discoverNotes().notes.get(STRK) ?? [];
      expect(notesAfter.length).toBe(1); // old note used, new surplus note created
      expect(notesAfter[0].amount).toBe(70n);
    });

    it("surplusTo on token builder: creates surplus note for that token only", async () => {
      // Alice starts with 1000n STRK, 500n ETH
      // Deposit to self for both tokens
      // prettier-ignore
      await alice
        .build(AUTO_OPTIONS)
        .with(STRK)
          .deposit(100n, ALICE_ADDRESS)
        .with(ETH)
          .deposit(50n, ALICE_ADDRESS)
        .execute();

      // After deposits: STRK 900n public, ETH 450n public
      const strkNote = (alice.discoverNotes().notes.get(STRK) ?? [])[0];
      const ethNote = (alice.discoverNotes().notes.get(ETH) ?? [])[0];

      // Use STRK with surplus, ETH without surplus
      // STRK: 100n in, 30n out -> 70n surplus
      // ETH: 50n in, 50n out -> no surplus (exact match)
      // prettier-ignore
      await alice
        .build(AUTO_OPTIONS)
        .with(STRK)
          .surplusTo(ALICE_ADDRESS)
          .inputs(strkNote)
          .withdraw({ amount: 30n })
        .with(ETH)
          .inputs(ethNote)
          .withdraw({ amount: 50n })
        .execute();

      // STRK: 930n public (900 + 30), 70n private surplus
      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(930n);
      const strkNotesAfter = alice.discoverNotes().notes.get(STRK) ?? [];
      expect(strkNotesAfter.length).toBe(1);
      expect(strkNotesAfter[0].amount).toBe(70n);

      // ETH: 500n public (450 + 50), no private notes
      expect(erc20s.get(ETH).balanceOf(ALICE_ADDRESS)).toBe(500n);
      const ethNotesAfter = alice.discoverNotes().notes.get(ETH) ?? [];
      expect(ethNotesAfter.length).toBe(0);
    });

    it("token-level surplusTo overrides root-level surplusTo", async () => {
      // Register Bob too for cross-user transfer
      await bob.build().register().execute();

      await bob.build().setup(BOB_ADDRESS).execute();
      bobSelfChannel = bob.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      const bobRegistry = createEmptyRegistry();
      bobRegistry.channels.set(BOB_ADDRESS, bobSelfChannel);
      await bob.build({ registry: bobRegistry }).with(STRK).setup(BOB_ADDRESS).execute();

      // Alice sets up channel to Bob
      await alice.build().setup(BOB_ADDRESS).execute();
      aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      const aliceRegistry = createEmptyRegistry();
      aliceRegistry.channels.set(BOB_ADDRESS, aliceToBobChannel);
      await alice.build({ registry: aliceRegistry }).with(STRK).setup(BOB_ADDRESS).execute();

      // Deposit to Alice (she starts with 1000n)
      // prettier-ignore
      await alice
        .build(AUTO_OPTIONS)
        .with(STRK)
          .deposit(100n, ALICE_ADDRESS)
        .execute();

      // After: 900n public, 100n private
      const note = (alice.discoverNotes().notes.get(STRK) ?? [])[0];

      // Root: surplus to self (Alice), but STRK override: surplus to Bob
      // 100n in, 30n withdrawn -> 70n surplus goes to Bob (not Alice)
      // prettier-ignore
      await alice
        .build(AUTO_OPTIONS)
        .surplusTo(ALICE_ADDRESS) // default: surplus to Alice
        .with(STRK)
          .surplusTo(BOB_ADDRESS) // override: surplus to Bob for STRK
          .inputs(note)
          .withdraw({ amount: 30n })
        .execute();

      // Alice has 930n public STRK (900 + 30), no private notes
      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(930n);
      const aliceNotesAfter = alice.discoverNotes().notes.get(STRK) ?? [];
      expect(aliceNotesAfter.length).toBe(0);

      // Bob has 70n private STRK (the surplus)
      const bobNotesAfter = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotesAfter.length).toBe(1);
      expect(bobNotesAfter[0].amount).toBe(70n);
    });

    it("no surplus note created when amounts are exactly balanced", async () => {
      // Alice starts with 1000n
      // prettier-ignore
      await alice
        .build(AUTO_OPTIONS)
        .with(STRK)
          .deposit(100n, ALICE_ADDRESS)
        .execute();

      // After: 900n public, 100n private
      const note = (alice.discoverNotes().notes.get(STRK) ?? [])[0];

      // 100n in, 100n out -> no surplus even with surplusTo set
      // prettier-ignore
      await alice
        .build(AUTO_OPTIONS)
        .surplusTo(ALICE_ADDRESS)
        .with(STRK)
          .inputs(note)
          .withdraw({ amount: 100n })
        .execute();

      // Alice has 1000n public (900 + 100), no private notes
      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(1000n);
      const notesAfter = alice.discoverNotes().notes.get(STRK) ?? [];
      expect(notesAfter.length).toBe(0);
    });

    it("without surplusTo, unbalanced amounts still fail", async () => {
      // prettier-ignore
      await alice
        .build(AUTO_OPTIONS)
        .with(STRK)
          .deposit(100n, ALICE_ADDRESS)
        .execute();

      const note = (alice.discoverNotes().notes.get(STRK) ?? [])[0];

      // 100n in, 50n out, no surplusTo -> should fail validation
      await expect(
        alice.build(AUTO_OPTIONS).with(STRK).inputs(note).withdraw({ amount: 50n }).execute()
      ).rejects.toThrow(/Final total for token.*is 50.*expected 0/);
    });
  });
});
