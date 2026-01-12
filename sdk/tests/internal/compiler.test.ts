import { describe, expect, it, beforeEach } from "vitest";
import { ERC20s, PrivacyPool, MockPrivateTransfers } from "../../src/testing/index.js";
import { Channel, createEmptyRegistry } from "../../src/interfaces.js";

// Test addresses (must be valid hex)
const POOL_ADDRESS = "0x1";
const ALICE_ADDRESS = "0xA11CE";
const ALICE_PRIVATE_KEY = 12345n;
const BOB_ADDRESS = "0xB0B";
const BOB_PRIVATE_KEY = 67890n;
const CAROL_ADDRESS = "0xCA201";
const STRK = "0x534752";
const ETH = "0x455448";

// Default options for auto-discovery, auto-setup, and auto-select notes
const AUTO_OPTIONS = {
  autoDiscover: { recipient: "refresh" as const, notes: "refresh" as const },
  autoSetup: true,
  autoSelectNotes: true,
};

describe("ActionCompiler (via builder)", () => {
  let erc20s: ERC20s;
  let pool: PrivacyPool;
  let alice: MockPrivateTransfers;
  let bob: MockPrivateTransfers;

  // Store channels for context
  let aliceToBobChannel: Channel;
  let aliceSelfChannel: Channel;

  beforeEach(() => {
    erc20s = new ERC20s();
    pool = new PrivacyPool(POOL_ADDRESS, erc20s);
    alice = new MockPrivateTransfers(pool, ALICE_ADDRESS, ALICE_PRIVATE_KEY);
    bob = new MockPrivateTransfers(pool, BOB_ADDRESS, BOB_PRIVATE_KEY);

    // Give Alice some tokens
    erc20s.get(STRK).setBalance(ALICE_ADDRESS, 1000n);
    erc20s.get(ETH).setBalance(ALICE_ADDRESS, 500n);
  });

  describe("autoDiscover.recipient", () => {
    beforeEach(async () => {
      // Register both users
      await alice.build().register().execute();
      await bob.build().register().execute();

      // Setup channel and token in the pool (so it exists for discovery)
      await alice.build().setup(BOB_ADDRESS).execute();
      aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(BOB_ADDRESS, aliceToBobChannel);
      await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute();
    });

    it("none: throws error when channel missing from registry", async () => {
      // Empty registry - no channel for Bob
      const emptyRegistry = createEmptyRegistry();

      await expect(
        alice
          .build({ registry: emptyRegistry, autoDiscover: { recipient: "none" }, autoSetup: false })
          .with(STRK)
          .deposit(100n, BOB_ADDRESS)
          .execute()
      ).rejects.toThrow(/Missing channel context for recipients/);
    });

    it("none: succeeds when channel exists in registry", async () => {
      // Registry with Bob's channel (and correct nonces from discovery)
      const registry = createEmptyRegistry();
      const discovered = alice.discoverChannels(BOB_ADDRESS);
      registry.channels.set(BOB_ADDRESS, discovered.channels.get(BOB_ADDRESS)!);

      // Should succeed using registry data
      await alice
        .build({ registry, autoDiscover: { recipient: "none" } })
        .with(STRK)
        .deposit(100n, BOB_ADDRESS)
        .execute();

      const bobNotes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotes.length).toBe(1);
      expect(bobNotes[0].amount).toBe(100n);
    });

    it("explicit: discovers only missing channels, updates registry", async () => {
      // Registry with Bob but not Carol
      const registry = createEmptyRegistry();
      const bobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;
      registry.channels.set(BOB_ADDRESS, bobChannel);

      // Carol registers so we can set up channel
      const carol = new MockPrivateTransfers(pool, CAROL_ADDRESS, 99999n);
      await carol.build().register().execute();

      // Setup Carol's channel in pool
      await alice.build().setup(CAROL_ADDRESS).execute();
      const carolChannel = alice.discoverChannels(CAROL_ADDRESS).channels.get(CAROL_ADDRESS)!;
      const carolRegistry = createEmptyRegistry();
      carolRegistry.channels.set(CAROL_ADDRESS, carolChannel);
      await alice.build({ registry: carolRegistry }).with(STRK).setup(CAROL_ADDRESS).execute();

      // explicit: should discover Carol (missing) but use registry for Bob
      const result = await alice
        .build({ registry, autoDiscover: { recipient: "explicit" } })
        .with(STRK)
        .deposit(50n, BOB_ADDRESS)
        .deposit(50n, CAROL_ADDRESS)
        .execute();

      // Both should be in registry now
      expect(result.registry.channels.has(BOB_ADDRESS)).toBe(true);
      expect(result.registry.channels.has(CAROL_ADDRESS)).toBe(true);

      // Verify deposits worked
      const bobNotes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotes.length).toBe(1);
      const carolNotes = carol.discoverNotes().notes.get(STRK) ?? [];
      expect(carolNotes.length).toBe(1);
    });

    it("refresh: discovers all recipients, updates registry with fresh nonces", async () => {
      // Start with an outdated registry (nonces at 0)
      const staleRegistry = createEmptyRegistry();
      const staleChannel = new Channel(aliceToBobChannel.key, aliceToBobChannel.recipientPublicKey); // fresh channel with nonce 0
      staleRegistry.channels.set(BOB_ADDRESS, staleChannel);

      // Do first deposit - this advances nonces in the pool
      await alice
        .build({ registry: staleRegistry, autoDiscover: { recipient: "refresh" } })
        .with(STRK)
        .deposit(50n, BOB_ADDRESS)
        .execute();

      // Do second deposit - refresh should get the updated nonces
      await alice
        .build({ registry: staleRegistry, autoDiscover: { recipient: "refresh" } })
        .with(STRK)
        .deposit(50n, BOB_ADDRESS)
        .execute();

      // Should have 2 notes (correct nonces used)
      const bobNotes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotes.length).toBe(2);
    });
  });

  describe("autoDiscover.notes", () => {
    beforeEach(async () => {
      // Register and setup Alice's self channel
      await alice.build().register().execute();
      await alice.build().setup(ALICE_ADDRESS).execute();
      aliceSelfChannel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(ALICE_ADDRESS, aliceSelfChannel);
      await alice.build({ registry }).with(STRK).setup(ALICE_ADDRESS).execute();

      // Deposit to create a note
      await alice.build(AUTO_OPTIONS).with(STRK).deposit(100n, ALICE_ADDRESS).execute();
    });

    it("none: does not discover notes, uses only registry notes", async () => {
      // Empty registry - no notes
      const emptyRegistry = createEmptyRegistry();
      emptyRegistry.channels.set(
        ALICE_ADDRESS,
        alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!
      );

      // With no notes in registry and no auto-select, withdraw should fail due to unbalanced
      await expect(
        alice
          .build({
            registry: emptyRegistry,
            autoDiscover: { notes: "none", recipient: "refresh" },
            autoSelectNotes: true,
          })
          .with(STRK)
          .withdraw({ amount: 50n })
          .execute()
      ).rejects.toThrow(/Running total for token.*went negative/);
    });

    it("none: succeeds when notes exist in registry", async () => {
      // Get fresh notes from discovery
      const discoveredNotes = alice.discoverNotes().notes;
      const registry = createEmptyRegistry();
      registry.channels.set(
        ALICE_ADDRESS,
        alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!
      );
      registry.notes.set(STRK, discoveredNotes.get(STRK) ?? []);

      // With notes in registry, withdraw should work
      await alice
        .build({
          registry,
          autoDiscover: { notes: "none", recipient: "refresh" },
          autoSelectNotes: true,
        })
        .with(STRK)
        .withdraw({ amount: 100n })
        .execute();

      // Alice should have public balance
      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(1000n); // 900 + 100 back
    });

    it("explicit: discovers notes only when registry is empty", async () => {
      // Empty registry - notes will be discovered
      const registry = createEmptyRegistry();
      registry.channels.set(
        ALICE_ADDRESS,
        alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!
      );

      // Should discover notes since registry is empty
      await alice
        .build({
          registry,
          autoDiscover: { notes: "explicit", recipient: "refresh" },
          autoSelectNotes: true,
        })
        .with(STRK)
        .withdraw({ amount: 100n })
        .execute();

      // Registry was populated with discovered notes (before they were used)
      // Note: the registry keeps track of discovered notes, not spent status
      expect(registry.notes.has(STRK)).toBe(true);

      // Alice should have public balance
      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(1000n);
    });

    it("explicit: uses existing registry notes, does not rediscover", async () => {
      // Registry with old note data (won't be refreshed)
      const existingNote = alice.discoverNotes().notes.get(STRK)![0];
      const registry = createEmptyRegistry();
      registry.channels.set(
        ALICE_ADDRESS,
        alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!
      );
      registry.notes.set(STRK, [existingNote]);

      // Uses the existing note from registry
      await alice
        .build({
          registry,
          autoDiscover: { notes: "explicit", recipient: "refresh" },
          autoSelectNotes: true,
        })
        .with(STRK)
        .withdraw({ amount: 100n })
        .execute();

      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(1000n);
    });

    it("refresh: discovers fresh notes even when registry has stale data", async () => {
      // Registry is empty (no notes) but pool has a note
      const registry = createEmptyRegistry();
      registry.channels.set(
        ALICE_ADDRESS,
        alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!
      );
      // Registry has NO notes, but pool has the note from beforeEach deposit

      // With refresh, it should discover the note and use it for withdraw
      await alice
        .build({
          registry,
          autoDiscover: { notes: "refresh", recipient: "refresh" },
          autoSelectNotes: true,
        })
        .with(STRK)
        .withdraw({ amount: 100n })
        .execute();

      // Withdraw succeeded (note was discovered from pool, not registry)
      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(1000n);

      // After spending the note, a fresh discovery should show no notes
      const freshNotes = alice.discoverNotes().notes.get(STRK) ?? [];
      expect(freshNotes.length).toBe(0);
    });
  });

  describe("autoSetup", () => {
    beforeEach(async () => {
      await alice.build().register().execute();
      await bob.build().register().execute();
    });

    it("true: adds OpenChannelAction when deposit recipient has no channel setup", async () => {
      // First set up token channel in pool (but not in our builder call)
      await alice.build().setup(BOB_ADDRESS).execute();
      aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(BOB_ADDRESS, aliceToBobChannel);
      await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute();

      // Deposit without explicit setup() - autoSetup should add OpenChannelAction
      const result = await alice
        .build({ autoSetup: true, autoDiscover: { recipient: "refresh" } })
        .with(STRK)
        .deposit(100n, BOB_ADDRESS)
        .execute();

      // Channel should be in registry
      expect(result.registry.channels.has(BOB_ADDRESS)).toBe(true);

      // Bob should have the note
      const bobNotes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotes.length).toBe(1);
    });

    it("true: adds OpenChannelAction when createNotes recipient has no channel", async () => {
      // Setup for Alice first
      await alice.build().setup(ALICE_ADDRESS).execute();
      aliceSelfChannel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;

      let registry = createEmptyRegistry();
      registry.channels.set(ALICE_ADDRESS, aliceSelfChannel);
      await alice.build({ registry }).with(STRK).setup(ALICE_ADDRESS).execute();

      // Deposit to self first
      await alice.build(AUTO_OPTIONS).with(STRK).deposit(100n, ALICE_ADDRESS).execute();

      // Setup Bob's channel and token in pool
      await alice.build().setup(BOB_ADDRESS).execute();
      aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;
      registry = createEmptyRegistry();
      registry.channels.set(BOB_ADDRESS, aliceToBobChannel);
      await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute();

      // Transfer to Bob without explicit setup - autoSetup should add OpenChannelAction
      const result = await alice
        .build({
          autoSetup: true,
          autoDiscover: { recipient: "refresh", notes: "refresh" },
          autoSelectNotes: true,
        })
        .with(STRK)
        .transfer({ recipient: BOB_ADDRESS, amount: 100n })
        .execute();

      expect(result.registry.channels.has(BOB_ADDRESS)).toBe(true);
      const bobNotes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotes.length).toBe(1);
    });

    it("false: throws error when channel not in registry and no explicit setup", async () => {
      await expect(
        alice
          .build({ autoSetup: false, autoDiscover: { recipient: "none" } })
          .with(STRK)
          .deposit(100n, BOB_ADDRESS)
          .execute()
      ).rejects.toThrow(/Missing channel context for recipients/);
    });

    it("false: succeeds when explicit setup() is called", async () => {
      // With autoSetup=false but explicit setup(), should work
      await alice.build({ autoSetup: false }).setup(BOB_ADDRESS).execute();

      const channels = alice.discoverChannels(BOB_ADDRESS);
      expect(channels.channels.has(BOB_ADDRESS)).toBe(true);
    });
  });

  describe("autoSelectNotes", () => {
    beforeEach(async () => {
      await alice.build().register().execute();

      // Setup self channel and token
      await alice.build().setup(ALICE_ADDRESS).execute();
      aliceSelfChannel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(ALICE_ADDRESS, aliceSelfChannel);
      await alice.build({ registry }).with(STRK).setup(ALICE_ADDRESS).execute();

      // Deposit to create notes
      await alice.build(AUTO_OPTIONS).with(STRK).deposit(100n, ALICE_ADDRESS).execute();
    });

    it("true: auto-selects notes from registry when no inputs() called", async () => {
      // Withdraw without calling inputs() - should auto-select
      await alice
        .build({
          autoDiscover: { notes: "refresh", recipient: "refresh" },
          autoSelectNotes: true,
        })
        .with(STRK)
        .withdraw({ amount: 100n })
        .execute();

      // Should have withdrawn (note auto-selected)
      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(1000n);
      const notes = alice.discoverNotes().notes.get(STRK) ?? [];
      expect(notes.length).toBe(0);
    });

    it("true: uses provided inputs() without auto-selection", async () => {
      // Get the note manually
      const note = alice.discoverNotes().notes.get(STRK)![0];

      // Provide inputs explicitly
      await alice
        .build({
          autoDiscover: { notes: "refresh", recipient: "refresh" },
          autoSelectNotes: true,
        })
        .with(STRK)
        .inputs(note)
        .withdraw({ amount: 100n })
        .execute();

      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(1000n);
    });

    it("false: does not auto-select, fails when inputs not provided", async () => {
      // No inputs, no auto-select - should fail with unbalanced amounts
      await expect(
        alice
          .build({
            autoDiscover: { notes: "refresh", recipient: "refresh" },
            autoSelectNotes: false,
          })
          .with(STRK)
          .withdraw({ amount: 100n })
          .execute()
      ).rejects.toThrow(/Running total for token.*went negative/);
    });

    it("false: succeeds when inputs() explicitly provided", async () => {
      const note = alice.discoverNotes().notes.get(STRK)![0];

      await alice
        .build({
          autoDiscover: { notes: "refresh", recipient: "refresh" },
          autoSelectNotes: false,
        })
        .with(STRK)
        .inputs(note)
        .withdraw({ amount: 100n })
        .execute();

      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(1000n);
    });
  });

  describe("registry updates", () => {
    it("channel nonces are updated after each operation", async () => {
      await alice.build().register().execute();
      await bob.build().register().execute();

      // Setup
      await alice.build().setup(BOB_ADDRESS).execute();
      aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(BOB_ADDRESS, aliceToBobChannel);
      await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute();

      // First deposit
      const result1 = await alice
        .build({ registry, autoDiscover: { recipient: "refresh" } })
        .with(STRK)
        .deposit(50n, BOB_ADDRESS)
        .execute();

      const channelAfter1 = result1.registry.channels.get(BOB_ADDRESS)!;
      const nonce1 = channelAfter1.tokens.get(STRK)!;

      // Second deposit
      const result2 = await alice
        .build({ registry, autoDiscover: { recipient: "refresh" } })
        .with(STRK)
        .deposit(50n, BOB_ADDRESS)
        .execute();

      const channelAfter2 = result2.registry.channels.get(BOB_ADDRESS)!;
      const nonce2 = channelAfter2.tokens.get(STRK)!;

      // Nonces should have advanced
      expect(nonce2.sequence).toBeGreaterThan(nonce1.sequence);

      // Both notes should exist
      const bobNotes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotes.length).toBe(2);
    });

    it("discovery refreshes registry notes before execution", async () => {
      await alice.build().register().execute();

      // Setup self channel
      await alice.build().setup(ALICE_ADDRESS).execute();
      aliceSelfChannel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(ALICE_ADDRESS, aliceSelfChannel);
      await alice.build({ registry }).with(STRK).setup(ALICE_ADDRESS).execute();

      // Deposit to create notes
      await alice.build(AUTO_OPTIONS).with(STRK).deposit(100n, ALICE_ADDRESS).execute();

      // Start with empty notes in registry
      expect(registry.notes.get(STRK)?.length ?? 0).toBe(0);

      // Withdraw using notes - discovery should populate registry
      await alice
        .build({
          registry,
          autoDiscover: { notes: "refresh", recipient: "refresh" },
          autoSelectNotes: true,
        })
        .with(STRK)
        .withdraw({ amount: 100n })
        .execute();

      // After optimistic update, spent notes are removed from registry
      expect(registry.notes.get(STRK)?.length ?? 0).toBe(0);

      // Verify withdraw succeeded
      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(1000n);

      // Fresh discovery confirms notes are gone in pool too
      const freshNotes = alice.discoverNotes().notes.get(STRK) ?? [];
      expect(freshNotes.length).toBe(0);
    });
  });

  describe("optimistic registry updates", () => {
    it("channel note nonces are updated after deposit", async () => {
      await alice.build().register().execute();
      await bob.build().register().execute();

      // Setup channel and token
      await alice.build().setup(BOB_ADDRESS).execute();
      aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(BOB_ADDRESS, aliceToBobChannel);
      await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute();

      // Record initial note nonce
      const initialNonce = registry.channels.get(BOB_ADDRESS)!.tokens.get(STRK)!.sequence;

      // Deposit to Bob
      await alice
        .build({ registry, autoDiscover: { recipient: "none" } })
        .with(STRK)
        .deposit(100n, BOB_ADDRESS)
        .execute();

      // Channel note nonce should be incremented
      const updatedNonce = registry.channels.get(BOB_ADDRESS)!.tokens.get(STRK)!.sequence;
      expect(updatedNonce).toBe(initialNonce + 1);

      // Registry channel should match discovery
      const discoveredChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;
      expect(updatedNonce).toBe(discoveredChannel.tokens.get(STRK)!.sequence);
    });

    it("spent notes are removed from registry after use", async () => {
      await alice.build().register().execute();

      // Setup self channel
      await alice.build().setup(ALICE_ADDRESS).execute();
      aliceSelfChannel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(ALICE_ADDRESS, aliceSelfChannel);
      await alice.build({ registry }).with(STRK).setup(ALICE_ADDRESS).execute();

      // Deposit to create a note
      await alice.build(AUTO_OPTIONS).with(STRK).deposit(100n, ALICE_ADDRESS).execute();

      // Discover notes and put them in registry
      const discovered = alice.discoverNotes().notes;
      registry.notes.set(STRK, discovered.get(STRK) ?? []);
      expect(registry.notes.get(STRK)?.length).toBe(1);

      // Use the note in a withdraw
      const result = await alice
        .build({
          registry,
          autoDiscover: { notes: "none", recipient: "none" },
          autoSelectNotes: true,
        })
        .with(STRK)
        .withdraw({ amount: 100n })
        .execute();

      // Registry should have no notes (spent note removed)
      expect(result.registry.notes.get(STRK)?.length ?? 0).toBe(0);
    });

    it("multiple deposits update channel note nonce correctly", async () => {
      await alice.build().register().execute();
      await bob.build().register().execute();

      // Setup channel and token
      await alice.build().setup(BOB_ADDRESS).execute();
      aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(BOB_ADDRESS, aliceToBobChannel);
      await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute();

      // Record initial note nonce
      const initialNonce = registry.channels.get(BOB_ADDRESS)!.tokens.get(STRK)!.sequence;

      // Two deposits in one execute
      await alice
        .build({ registry, autoDiscover: { recipient: "none" } })
        .with(STRK)
        .deposit(50n, BOB_ADDRESS)
        .deposit(30n, BOB_ADDRESS)
        .execute();

      // Channel note nonce should be incremented by 2
      const updatedNonce = registry.channels.get(BOB_ADDRESS)!.tokens.get(STRK)!.sequence;
      expect(updatedNonce).toBe(initialNonce + 2);

      // Bob should have 2 notes via discovery
      const bobNotes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotes.length).toBe(2);
    });

    it("partial spend removes used note, remainder needs discovery", async () => {
      await alice.build().register().execute();

      // Setup self channel
      await alice.build().setup(ALICE_ADDRESS).execute();
      aliceSelfChannel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(ALICE_ADDRESS, aliceSelfChannel);
      await alice.build({ registry }).with(STRK).setup(ALICE_ADDRESS).execute();

      // Create two notes
      await alice.build(AUTO_OPTIONS).with(STRK).deposit(100n, ALICE_ADDRESS).execute();
      await alice.build(AUTO_OPTIONS).with(STRK).deposit(50n, ALICE_ADDRESS).execute();

      // Refresh registry with current state (notes + updated channel nonces)
      const discovered = alice.discoverNotes().notes;
      registry.notes.set(STRK, [...(discovered.get(STRK) ?? [])]);
      expect(registry.notes.get(STRK)?.length).toBe(2);

      // Also refresh channel to get updated nonces
      const refreshedChannel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;
      registry.channels.set(ALICE_ADDRESS, refreshedChannel);

      // Use one note in a withdrawal, create remainder
      const notes = registry.notes.get(STRK)!;
      const note100 = notes.find((n) => n.amount === 100n)!;

      const result = await alice
        .build({ registry, autoDiscover: { notes: "none", recipient: "none" } })
        .with(STRK)
        .inputs(note100)
        .withdraw({ amount: 70n })
        .transfer({ recipient: ALICE_ADDRESS, amount: 30n }) // remainder
        .execute();

      // Registry should have only the unused 50n note (spent note removed, remainder not added)
      const updatedNotes = result.registry.notes.get(STRK) ?? [];
      expect(updatedNotes.length).toBe(1);
      expect(updatedNotes[0].amount).toBe(50n);

      // After discovery, Alice should have both the 50n and the 30n remainder
      const freshNotes = alice.discoverNotes().notes.get(STRK) ?? [];
      expect(freshNotes.length).toBe(2);
      expect(freshNotes.map((n) => n.amount).sort()).toEqual([30n, 50n]);
    });

    it("token nonce is updated after openTokenChannel", async () => {
      await alice.build().register().execute();
      await bob.build().register().execute();

      // Setup channel
      await alice.build().setup(BOB_ADDRESS).execute();
      aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(BOB_ADDRESS, aliceToBobChannel);

      // Record initial token nonce
      const initialTokenNonce = registry.channels.get(BOB_ADDRESS)!.tokenNonce.sequence;

      // Setup token channel
      await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute();

      // Token nonce should be incremented
      const updatedTokenNonce = registry.channels.get(BOB_ADDRESS)!.tokenNonce.sequence;
      expect(updatedTokenNonce).toBe(initialTokenNonce + 1);

      // Registry should match discovery
      const discoveredChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;
      expect(updatedTokenNonce).toBe(discoveredChannel.tokenNonce.sequence);
    });

    it("registry channel matches discovery after multiple operations", async () => {
      await alice.build().register().execute();
      await bob.build().register().execute();

      // Setup channel
      await alice.build().setup(BOB_ADDRESS).execute();
      aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(BOB_ADDRESS, aliceToBobChannel);

      // Setup two tokens
      await alice
        .build({ registry })
        .with(STRK)
        .setup(BOB_ADDRESS)
        .with(ETH)
        .setup(BOB_ADDRESS)
        .execute();

      // Multiple deposits to both tokens
      await alice
        .build({ registry, autoDiscover: { recipient: "none" } })
        .with(STRK)
        .deposit(100n, BOB_ADDRESS)
        .deposit(50n, BOB_ADDRESS)
        .with(ETH)
        .deposit(200n, BOB_ADDRESS)
        .execute();

      // Registry channel should exactly match discovery
      const registryChannel = registry.channels.get(BOB_ADDRESS)!;
      const discoveredChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      // Compare channel key
      expect(registryChannel.key).toBe(discoveredChannel.key);

      // Compare token nonce
      expect(registryChannel.tokenNonce.sequence).toBe(discoveredChannel.tokenNonce.sequence);

      // Compare note nonces for each token
      expect(registryChannel.tokens.get(STRK)!.sequence).toBe(
        discoveredChannel.tokens.get(STRK)!.sequence
      );
      expect(registryChannel.tokens.get(ETH)!.sequence).toBe(
        discoveredChannel.tokens.get(ETH)!.sequence
      );
    });

    it("registry notes match discovery after spending", async () => {
      await alice.build().register().execute();

      // Setup self channel
      await alice.build().setup(ALICE_ADDRESS).execute();
      aliceSelfChannel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(ALICE_ADDRESS, aliceSelfChannel);
      await alice.build({ registry }).with(STRK).setup(ALICE_ADDRESS).execute();

      // Create three notes
      await alice.build(AUTO_OPTIONS).with(STRK).deposit(100n, ALICE_ADDRESS).execute();
      await alice.build(AUTO_OPTIONS).with(STRK).deposit(50n, ALICE_ADDRESS).execute();
      await alice.build(AUTO_OPTIONS).with(STRK).deposit(25n, ALICE_ADDRESS).execute();

      // Sync registry with discovery
      registry.notes = alice.discoverNotes().notes;
      const refreshedChannel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;
      registry.channels.set(ALICE_ADDRESS, refreshedChannel);

      expect(registry.notes.get(STRK)?.length).toBe(3);

      // Spend one note (the 50n one)
      const notes = registry.notes.get(STRK)!;
      const note50 = notes.find((n) => n.amount === 50n)!;

      await alice
        .build({ registry, autoDiscover: { notes: "none", recipient: "none" } })
        .with(STRK)
        .inputs(note50)
        .withdraw({ amount: 50n })
        .execute();

      // Registry should have 2 notes
      const registryNotes = registry.notes.get(STRK) ?? [];
      expect(registryNotes.length).toBe(2);
      const sortBigint = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
      expect(registryNotes.map((n) => n.amount).sort(sortBigint)).toEqual([25n, 100n]);

      // Discovery should also return 2 notes with same amounts
      const discoveredNotes = alice.discoverNotes().notes.get(STRK) ?? [];
      expect(discoveredNotes.length).toBe(2);
      expect(discoveredNotes.map((n) => n.amount).sort(sortBigint)).toEqual([25n, 100n]);

      // Note IDs should match
      const registryIds = new Set(registryNotes.map((n) => BigInt(n.id as bigint)));
      const discoveredIds = new Set(discoveredNotes.map((n) => BigInt(n.id as bigint)));
      expect(registryIds).toEqual(discoveredIds);
    });
  });

  describe("deposit and note creation", () => {
    it("deposit creates note for recipient", async () => {
      await alice.build().register().execute();
      await bob.build().register().execute();

      // Set up channel and token
      await alice.build().setup(BOB_ADDRESS).execute();
      aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(BOB_ADDRESS, aliceToBobChannel);
      await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute();

      // Deposit using builder
      await alice.build(AUTO_OPTIONS).with(STRK).deposit(100n, BOB_ADDRESS).execute();

      // Bob should have a note
      const bobNotes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotes.length).toBe(1);
      expect(bobNotes[0].amount).toBe(100n);

      // Alice's public balance should decrease
      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(900n);
    });

    it("transfer creates notes using input notes", async () => {
      await alice.build().register().execute();
      await bob.build().register().execute();

      // Setup self channel for Alice
      await alice.build().setup(ALICE_ADDRESS).execute();
      aliceSelfChannel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(ALICE_ADDRESS, aliceSelfChannel);
      await alice.build({ registry }).with(STRK).setup(ALICE_ADDRESS).execute();

      // Deposit to self using builder
      await alice.build(AUTO_OPTIONS).with(STRK).deposit(100n, ALICE_ADDRESS).execute();

      // Alice should have a note
      let aliceNotes = alice.discoverNotes().notes.get(STRK) ?? [];
      expect(aliceNotes.length).toBe(1);

      // Setup channel to Bob
      await alice.build().setup(BOB_ADDRESS).execute();
      aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;
      registry.channels.set(BOB_ADDRESS, aliceToBobChannel);
      await alice.build({ registry }).with(STRK).setup(BOB_ADDRESS).execute();

      // Transfer to Bob using builder
      await alice
        .build(AUTO_OPTIONS)
        .with(STRK)
        .transfer({ recipient: BOB_ADDRESS, amount: 100n })
        .execute();

      // Alice should have no notes (used the input via auto-select)
      aliceNotes = alice.discoverNotes().notes.get(STRK) ?? [];
      expect(aliceNotes.length).toBe(0);

      // Bob should have the note
      const bobNotes = bob.discoverNotes().notes.get(STRK) ?? [];
      expect(bobNotes.length).toBe(1);
      expect(bobNotes[0].amount).toBe(100n);
    });
  });

  describe("multi-token operations", () => {
    it("handles multiple tokens in one execute", async () => {
      await alice.build().register().execute();
      await bob.build().register().execute();

      // Set up channel and tokens
      await alice.build().setup(BOB_ADDRESS).execute();
      aliceToBobChannel = alice.discoverChannels(BOB_ADDRESS).channels.get(BOB_ADDRESS)!;

      const registry = createEmptyRegistry();
      registry.channels.set(BOB_ADDRESS, aliceToBobChannel);
      await alice
        .build({ registry })
        .with(STRK)
        .setup(BOB_ADDRESS)
        .with(ETH)
        .setup(BOB_ADDRESS)
        .execute();

      // Deposit multiple tokens using builder
      await alice
        .build(AUTO_OPTIONS)
        .with(STRK)
        .deposit(100n, BOB_ADDRESS)
        .with(ETH)
        .deposit(50n, BOB_ADDRESS)
        .execute();

      // Bob should have notes for both tokens
      const bobStrkNotes = bob.discoverNotes().notes.get(STRK) ?? [];
      const bobEthNotes = bob.discoverNotes().notes.get(ETH) ?? [];

      expect(bobStrkNotes.length).toBe(1);
      expect(bobStrkNotes[0].amount).toBe(100n);
      expect(bobEthNotes.length).toBe(1);
      expect(bobEthNotes[0].amount).toBe(50n);

      // Alice's balances should decrease
      expect(erc20s.get(STRK).balanceOf(ALICE_ADDRESS)).toBe(900n);
      expect(erc20s.get(ETH).balanceOf(ALICE_ADDRESS)).toBe(450n);
    });
  });
});
