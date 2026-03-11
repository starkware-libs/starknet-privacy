import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { constants } from "starknet";
import {
  Devnet,
  CallMockProofProvider,
  IndexerDiscoveryProvider,
} from "starknet-sdk/testing";
import {
  createPrivateTransfers,
  type PrivateTransfersInterface,
  type HistoryTransaction,
} from "starknet-sdk";
import { createE2eTestEnv, type E2eTestEnv } from "../src/harness.js";

describe("E2E History", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let indexerDiscovery: IndexerDiscoveryProvider;
  let aliceTransfers: PrivateTransfersInterface;
  let bobTransfers: PrivateTransfersInterface;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet);
    const { env: de } = env;

    indexerDiscovery = new IndexerDiscoveryProvider(
      env.indexer.apiUrl,
      de.privacy.address,
    );
    const chainId = constants.StarknetChainId.SN_SEPOLIA;

    aliceTransfers = createPrivateTransfers({
      account: de.alice,
      viewingKeyProvider: { getViewingKey: async () => BigInt("0xA11CE") },
      provingProvider: new CallMockProofProvider(de.provider, chainId),
      discoveryProvider: indexerDiscovery,
      poolContractAddress: de.privacy.address,
    });

    bobTransfers = createPrivateTransfers({
      account: de.bob,
      viewingKeyProvider: { getViewingKey: async () => BigInt("0xB0B") },
      provingProvider: new CallMockProofProvider(de.provider, chainId),
      discoveryProvider: indexerDiscovery,
      poolContractAddress: de.privacy.address,
    });

    // Approve STRK spending
    await de.alice.execute({
      contractAddress: de.strk,
      entrypoint: "approve",
      calldata: [de.privacy.address, 100n, 0n],
    });

    // Register bob
    const { callAndProof: bobReg } = await bobTransfers
      .build()
      .register()
      .execute();
    await devnet.executeOutside(bobReg);

    // Alice: deposit 100 STRK + transfer 50 to bob
    const { callAndProof } = await aliceTransfers
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
    await env.indexer.waitForNewLog("New block #", 15_000);

    // Bob withdraws 50 STRK
    const { callAndProof: bobWithdraw } = await bobTransfers
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
    await env.indexer.waitForNewLog("New block #", 15_000);
  }, 60_000);

  afterAll(async () => {
    env?.indexer.shutdown();
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
    const { cursor: channelCursor } = await indexerDiscovery.discoverChannels(
      aliceAddress,
      aliceViewingKey,
      "all",
    );

    const historyPage = await indexerDiscovery.fetchHistory(
      aliceAddress,
      notesCursor,
      channelCursor,
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
    const { cursor: channelCursor } = await indexerDiscovery.discoverChannels(
      aliceAddress,
      aliceViewingKey,
      "all",
    );

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
    const { cursor: channelCursor } = await indexerDiscovery.discoverChannels(
      bobAddress,
      bobViewingKey,
      "all",
    );

    const historyPage = await indexerDiscovery.fetchHistory(
      bobAddress,
      notesCursor,
      channelCursor,
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
