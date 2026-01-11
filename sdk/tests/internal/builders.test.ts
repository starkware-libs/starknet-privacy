import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { ERC20s, PrivacyPool, MockPrivateTransfers } from "../../src/testing/index.js";
import {
  withLogging,
  consoleLogCallback,
  debugHint,
  isDebugEnabled,
  hashes,
} from "../../src/utils/index.js";
import type { PrivateRecipient } from "../../src/interfaces.js";
import { Channel, open, SetupRequirement } from "../../src/interfaces.js";

// Test addresses and keys (must be valid hex addresses convertible to BigInt)
const POOL_ADDRESS = "0x1";
const STRK = "0x534752"; // Fake STRK token address
const ETH = "0x455448"; // Fake ETH token address

const ALICE_ADDRESS = "0xA11CE";
const ALICE_PRIVATE_KEY = 12345n;

const BOB_ADDRESS = "0xB0B";
const BOB_PRIVATE_KEY = 67890n;

describe("PrivateTransfersBuilder", () => {
  let erc20s: ERC20s;
  let pool: PrivacyPool;
  let alice: MockPrivateTransfers;
  let bob: MockPrivateTransfers;

  // Helper to compute channel and set context on a PrivateRecipient
  const setContext = (
    from: { address: string; key: bigint },
    recipient: PrivateRecipient
  ): void => {
    const toPublicKey = pool.getPublicKey(recipient.address);
    const channelKey = hashes.channelKey(from.address, from.key, recipient.address, toPublicKey);
    recipient.context = new Channel(channelKey);
  };

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

    // Alice registers first so she can compute channels
    await alice.register();

    // Create recipient and compute context (both users must be registered)
    const bobRecipient: PrivateRecipient = { address: BOB_ADDRESS, context: undefined! };
    setContext({ address: ALICE_ADDRESS, key: ALICE_PRIVATE_KEY }, bobRecipient);

    // Use builder to setup channel, setup token, and deposit
    // prettier-ignore
    await alice
      .build()
      .setup(BOB_ADDRESS)
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

    // Both users register first
    await bob.register();
    await alice.register();

    // Create recipients and compute contexts
    const aliceSelf: PrivateRecipient = { address: ALICE_ADDRESS, context: undefined! };
    const bobRecipient: PrivateRecipient = { address: BOB_ADDRESS, context: undefined! };
    setContext({ address: ALICE_ADDRESS, key: ALICE_PRIVATE_KEY }, aliceSelf);
    setContext({ address: ALICE_ADDRESS, key: ALICE_PRIVATE_KEY }, bobRecipient);

    // Alice sets up channels, tokens, and deposits - all via builder
    // prettier-ignore
    await alice
      .build()
      .setup(ALICE_ADDRESS) // channel to self for deposits
      .setup(BOB_ADDRESS) // channel to Bob for transfers
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
    // Setup: Alice registers and deposits 100n STRK to herself
    await alice.register();
    const aliceSelf: PrivateRecipient = { address: ALICE_ADDRESS, context: undefined! };
    setContext({ address: ALICE_ADDRESS, key: ALICE_PRIVATE_KEY }, aliceSelf);

    await alice
      .build()
      .setup(ALICE_ADDRESS)
      .with(STRK)
      .setup(aliceSelf)
      .deposit(100n, aliceSelf)
      .execute();

    // Get Alice's note
    const strkNote = (alice.discoverNotes().notes.get(STRK) ?? [])[0];
    expect(strkNote).toBeDefined();

    // Try to transfer only 50n (leaving 50n unaccounted for) - should fail
    // Pool validates that final total per token is 0 (input 100n - output 50n = 50n != 0)
    await expect(
      alice.build().with(STRK).inputs(strkNote).withdraw({ amount: 50n }).execute()
    ).rejects.toThrow(/Final total for token.*is 50.*expected 0/);
  });

  it("builder: register, setup channel, and deposit in one batch", async () => {
    // Bob needs to be registered first
    await bob.register();

    // Alice does everything in one builder call
    const result = await alice.build().register().setup(BOB_ADDRESS).execute();

    expect(result).toBeDefined();
    // Verify Alice is registered (not requiring Register)
    const aliceReq = await alice.discoverRequirement(
      { address: ALICE_ADDRESS, context: undefined! },
      "0x0"
    );
    expect(aliceReq).not.toBe(SetupRequirement.Register);

    // Verify channel was set up by discovering it
    const channels = alice.discoverChannels(BOB_ADDRESS);
    expect(channels.channels.has(BOB_ADDRESS)).toBe(true);
  });

  it("open notes: Bob creates open note, Alice deposits into it", async () => {
    // Both users register
    await bob.register();
    await alice.register();

    // Create recipients and compute contexts
    const bobSelf: PrivateRecipient = { address: BOB_ADDRESS, context: undefined! };
    const aliceToBob: PrivateRecipient = { address: BOB_ADDRESS, context: undefined! };
    setContext({ address: BOB_ADDRESS, key: BOB_PRIVATE_KEY }, bobSelf);
    setContext({ address: ALICE_ADDRESS, key: ALICE_PRIVATE_KEY }, aliceToBob);

    // prettier-ignore
    await bob
      .build()
      .setup(BOB_ADDRESS) // channel to self
      .with(STRK)
        .setup(bobSelf)
      .execute();

    // prettier-ignore
    await alice
      .build()
      .setup(BOB_ADDRESS) // channel to Bob
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
