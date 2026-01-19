import { describe, expect, it, beforeEach, afterAll } from "vitest";
import {
  MockContracts,
  PrivacyPool,
  MockPrivateTransfers,
  applyStateChanges,
  MockSwapHelper,
} from "../../src/testing/index.js";
import {
  withLogging,
  consoleLogCallback,
  debugHint,
  isDebugEnabled,
} from "../../src/utils/index.js";
import { hashes } from "../../src/utils/hashes.js";
import { Open, type Actions } from "../../src/interfaces.js";

// Test addresses and keys
const POOL_ADDRESS = "0x1";
const STRK = "0x534752";
const ETH = "0x455448";
const SWAP_HELPER_ADDRESS = "0x555";

const ALICE_ADDRESS = "0xA11CE";
const ALICE_PRIVATE_KEY = 12345n;

const AUTO_OPTIONS = {
  autoDiscover: { channels: "refresh" as const },
  autoSetup: true,
};

describe("Swap Scenario", () => {
  let contracts: MockContracts;
  let pool: PrivacyPool;
  let alice: MockPrivateTransfers;
  let swapHelper: MockSwapHelper;

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

    swapHelper = new MockSwapHelper(SWAP_HELPER_ADDRESS, contracts);
    contracts.register(swapHelper);

    alice = new MockPrivateTransfers(contracts, POOL_ADDRESS, ALICE_ADDRESS, ALICE_PRIVATE_KEY);

    // Initial setup for tokens
    contracts.get(STRK).setBalance(ALICE_ADDRESS, 1000n);
    contracts.get(ETH).setBalance(ALICE_ADDRESS, 0n);
  });

  it("withdraws STRK, calls swap helper, and fills open ETH note", async () => {
    applyStateChanges(await alice.build().register().execute());

    // 1. Register and setup channels for Alice (for both tokens)
    applyStateChanges(
      await alice
        .build(AUTO_OPTIONS)
        .setup(ALICE_ADDRESS)
        .with(STRK)
        .setup(ALICE_ADDRESS)
        .deposit({ amount: 100n, recipient: ALICE_ADDRESS })
        .with(ETH)
        .setup(ALICE_ADDRESS)
        .execute()
    );

    // 2. Prepare the swap transaction
    // Get fresh channel state to calculate note ID
    const channel = alice.discoverChannels(ALICE_ADDRESS).channels.get(ALICE_ADDRESS)!;
    const ethNonce = channel.tokens.get(ETH)!.noteNonce;

    // Calculate note ID for the upcoming ETH open note
    // noteId = h(channelKey, token, index)
    const ethNoteId = hashes.noteId(channel.key!, ETH, ethNonce);

    // Construct raw actions
    // - CreateNote (ETH, open)
    // - Withdraw (STRK, 10n, to SwapHelper)
    // - FollowupCall (swapHelper.swap(STRK, ETH, 10n, POOL, ethNoteId))

    // We need to use a note for withdrawal
    const strkNotes = alice.discoverNotes().notes.get(STRK) ?? [];
    const strkNote = strkNotes[0];

    const actions: Actions = {
      createNotes: [
        {
          recipient: ALICE_ADDRESS,
          token: ETH,
          amount: Open,
        },
        // Re-create the change (90n) as a new note
        {
          recipient: ALICE_ADDRESS,
          token: STRK,
          amount: 90n,
        },
      ],
      withdraws: [
        {
          recipient: SWAP_HELPER_ADDRESS,
          token: STRK,
          amount: 10n,
        },
      ],
      useNotes: [
        {
          token: STRK,
          note: strkNote,
        },
      ],
      deposits: [], // No new deposits from L1
      followupCall: {
        call: {
          contractAddress: SWAP_HELPER_ADDRESS,
          entrypoint: "swap",
          calldata: [STRK, ETH, 10n, POOL_ADDRESS, ethNoteId],
        },
      },
    };

    // Execute
    applyStateChanges(await alice.execute(actions, AUTO_OPTIONS));

    // 4. Verify results

    // Alice should have 90n STRK private note (change)
    const finalStrkNotes = alice.discoverNotes().notes.get(STRK) ?? [];
    // Note: discoverNotes relies on the mock provider which sees pool state.
    // The pool state should have the new note.
    // Wait, createNotes adds a note, deposits with recipient adds a note.
    // We added a deposit(90n) -> that creates a note.
    expect(finalStrkNotes.length).toBe(1);
    expect(finalStrkNotes[0].amount).toBe(90n);

    // Alice should have 20n ETH private note (10n * 2 from swap)
    // The open note was created with 0 amount, then filled by swap helper.
    const finalEthNotes = alice.discoverNotes().notes.get(ETH) ?? [];
    expect(finalEthNotes.length).toBe(1);
    expect(finalEthNotes[0].amount).toBe(20n); // Swap helper gives 2x
    expect(finalEthNotes[0].open).toBe(true); // Still marked open in structure but filled

    // Verify MockSwapHelper balances if possible (it burns/mints so maybe just check calls happened)
    // But MockSwapHelper implementation:
    // contracts.get(fromToken).setBalance(this.address, 0n);
    // contracts.get(toToken).setBalance(this.address, amount * 2n);
    // contracts.get<PrivacyPool>(poolAddress).openDeposit(noteId, toToken, amount * 2n);

    // We can verify that the swap helper correctly received the funds temporarily
    // (though in the synchronous execution it's already done)
  });
});
