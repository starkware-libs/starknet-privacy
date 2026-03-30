import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Devnet,
  IndexerDiscoveryProvider,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import { type HistoryTransaction } from "@starkware-libs/starknet-privacy-sdk";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";
import { E2E_TIMEOUTS } from "../../src/timeouts.js";

describe("E2E History", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let indexerDiscovery: IndexerDiscoveryProvider;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet);
    const { env: de, transfers } = env;

    indexerDiscovery = new IndexerDiscoveryProvider(
      env.indexer.apiUrl,
      de.privacy.address,
    );

    // Approve STRK spending
    await de.alice.execute({
      contractAddress: de.strk,
      entrypoint: "approve",
      calldata: [de.privacy.address, 100n, 0n],
    });

    // Register bob
    const { callAndProof: bobReg } = await transfers.bob
      .build()
      .register()
      .execute();
    await devnet.executeOutside(bobReg);

    // Alice: deposit 100 STRK + transfer 50 to bob
    const { callAndProof } = await transfers.alice
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(de.strk)
      .deposit({ amount: 100n })
      .transfer({ recipient: de.bob.address, amount: 50n })
      .surplusTo(de.alice.address)
      .execute();

    await devnet.executeOutside(callAndProof);

    // Create block + wait for indexer
    await createBlock();
    await env.indexer.waitForNewLog("New block #", E2E_TIMEOUTS.indexerLog);

    // Bob withdraws 50 STRK
    const { callAndProof: bobWithdraw } = await transfers.bob
      .build({
        autoDiscover: { notes: "refresh", channels: "refresh" },
        autoSelectNotes: "naive",
      })
      .with(de.strk)
      .withdraw({ amount: 50n, recipient: de.bob.address })
      .execute();

    await devnet.executeOutside(bobWithdraw);

    // Create block + wait for indexer
    await createBlock();
    await env.indexer.waitForNewLog("New block #", E2E_TIMEOUTS.indexerLog);
  });

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  async function createBlock() {
    await fetch(devnet.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "devnet_createBlock",
      }),
    });
  }

  it("Alice history shows deposit and transfer", async () => {
    const { env: de } = env;
    const aliceAddress = BigInt(de.alice.address);
    const aliceViewingKey = BigInt("0xA11CE");

    const { cursor: notesCursor } = await indexerDiscovery.discoverNotes(
      aliceAddress,
      aliceViewingKey,
    );
    const { channels } = await indexerDiscovery.discoverChannels(
      aliceAddress,
      aliceViewingKey,
      "all",
    );

    const historyPage = await indexerDiscovery.fetchHistory(
      aliceAddress,
      notesCursor,
      { channels },
    );

    expect(historyPage.blockRef).toBeDefined();
    expect(historyPage.cursor.historyComplete).toBe(true);
    expect(historyPage.transactions.length).toBeGreaterThan(0);

    const allNotes = historyPage.transactions.flatMap((tx) => tx.notes);
    const allDeposits = historyPage.transactions.flatMap((tx) => tx.deposits);

    // Alice deposited 100 STRK
    expect(allDeposits.length).toBeGreaterThanOrEqual(1);
    const deposit = allDeposits.find(
      (d) => d.amount === 100n && d.token === BigInt(de.strk),
    );
    expect(deposit).toBeDefined();

    // Notes: 50 STRK change to self + 50 STRK transfer to Bob
    expect(allNotes.length).toBeGreaterThanOrEqual(2);
    const noteAmounts = allNotes
      .filter((n) => n.token === BigInt(de.strk))
      .map((n) => n.amount)
      .sort();
    expect(noteAmounts).toContain(50n);
  });

  it("Alice history paginates correctly with maxTransactions=1", async () => {
    const { env: de } = env;
    const aliceAddress = BigInt(de.alice.address);
    const aliceViewingKey = BigInt("0xA11CE");

    const { cursor: notesCursor } = await indexerDiscovery.discoverNotes(
      aliceAddress,
      aliceViewingKey,
    );
    const { channels } = await indexerDiscovery.discoverChannels(
      aliceAddress,
      aliceViewingKey,
      "all",
    );
    const channelCursor = { channels };

    // Fetch one transaction at a time
    const allTransactions: HistoryTransaction[] = [];
    let historyCursor: undefined | typeof firstPage.cursor = undefined;
    let blockRef: string | undefined;

    const firstPage = await indexerDiscovery.fetchHistory(
      aliceAddress,
      notesCursor,
      channelCursor,
      { maxTransactions: 1 },
    );
    allTransactions.push(...firstPage.transactions);
    historyCursor = firstPage.cursor;
    blockRef = firstPage.blockRef;

    // Continue fetching until complete
    while (!historyCursor.historyComplete) {
      const page = await indexerDiscovery.fetchHistory(
        aliceAddress,
        notesCursor,
        channelCursor,
        { maxTransactions: 1, historyCursor, blockRef },
      );
      allTransactions.push(...page.transactions);
      historyCursor = page.cursor;
      blockRef = page.blockRef;
    }

    // Should have fetched multiple pages (scenario has at least 1 tx)
    expect(allTransactions.length).toBeGreaterThan(0);

    // Verify same data as non-paginated: deposit of 100 STRK and note of 50 STRK
    const allDeposits = allTransactions.flatMap((tx) => tx.deposits);
    expect(
      allDeposits.find((d) => d.amount === 100n && d.token === BigInt(de.strk)),
    ).toBeDefined();

    const allNotes = allTransactions.flatMap((tx) => tx.notes);
    const noteAmounts = allNotes
      .filter((n) => n.token === BigInt(de.strk))
      .map((n) => n.amount);
    expect(noteAmounts).toContain(50n);
  });

  it("Bob history shows incoming transfer and withdrawal", async () => {
    const { env: de } = env;
    const bobAddress = BigInt(de.bob.address);
    const bobViewingKey = BigInt("0xB0B");

    const { cursor: notesCursor } = await indexerDiscovery.discoverNotes(
      bobAddress,
      bobViewingKey,
    );
    const { channels } = await indexerDiscovery.discoverChannels(
      bobAddress,
      bobViewingKey,
      "all",
    );

    const historyPage = await indexerDiscovery.fetchHistory(
      bobAddress,
      notesCursor,
      { channels },
    );

    expect(historyPage.blockRef).toBeDefined();
    expect(historyPage.cursor.historyComplete).toBe(true);

    // Bob received 50 STRK from Alice
    const allNotes = historyPage.transactions.flatMap((tx) => tx.notes);
    const incomingNote = allNotes.find(
      (n) =>
        n.channelKind === "incoming" &&
        n.amount === 50n &&
        n.token === BigInt(de.strk),
    );
    expect(incomingNote).toBeDefined();

    // Bob withdrew 50 STRK
    const allWithdrawals = historyPage.transactions.flatMap(
      (tx) => tx.withdrawals,
    );
    const withdrawal = allWithdrawals.find(
      (w) => w.amount === 50n && w.token === BigInt(de.strk),
    );
    expect(withdrawal).toBeDefined();
  });
});
