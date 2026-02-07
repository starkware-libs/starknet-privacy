import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { constants } from "starknet";
import type { DevnetEnvironment } from "starknet-sdk/testing";
import path from "path";
import { fileURLToPath } from "url";
import { Devnet, CallMockProofProvider, IndexerDiscoveryProvider } from "starknet-sdk/testing";
import { createPrivateTransfers, type PrivateTransfersInterface } from "starknet-sdk";
import { createE2eTestEnv, type E2eTestEnv } from "../src/harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEXER_LOG = path.join(__dirname, "../indexer-discovery.log");

/**
 * Stress test: payment service discovery with ~94 notes across many channels.
 *
 * Alice acts as a payment service, interacting with 9 users across 2 tokens.
 * The volume forces multi-page pagination (SERVER_BUDGET=100, COST_NOTE=2).
 */
describe("Payment Service Discovery", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;

  // 9 users (bob + 8 extra accounts)
  let users: DevnetEnvironment["extraAccounts"];
  let userTransfers: PrivateTransfersInterface[];
  let aliceTransfers: PrivateTransfersInterface;

  const ALICE_KEY = BigInt("0xA11CE");
  const userKey = (i: number) => BigInt(0xc000 + i);

  beforeAll(async () => {
    devnet = new Devnet({ userAccounts: 10 });
    env = await createE2eTestEnv(devnet, { indexer: { logFile: INDEXER_LOG } });

    const { env: de } = env;
    const chainId = constants.StarknetChainId.SN_SEPOLIA;
    const indexerDiscovery = new IndexerDiscoveryProvider(env.indexer.apiUrl);

    users = [de.bob, ...de.extraAccounts];
    aliceTransfers = env.transfers.alice;

    // Create PrivateTransfersInterface for each user
    userTransfers = users.map((account, i) =>
      createPrivateTransfers({
        account,
        viewingKeyProvider: { getViewingKey: () => userKey(i) },
        provingProvider: new CallMockProofProvider(de.provider, chainId),
        discoveryProvider: indexerDiscovery,
        poolContractAddress: de.privacy.address,
      }),
    );

    // --- Register all 10 participants ---
    for (const ut of userTransfers) {
      const { callAndProof } = await ut.build().register().execute();
      await devnet.executeOutside(callAndProof);
    }

    // --- Approve STRK + ETH for alice ---
    const approvalAmount = 100_000n;
    await de.alice.execute([
      {
        contractAddress: de.strk,
        entrypoint: "approve",
        calldata: [de.privacy.address, approvalAmount, 0n],
      },
      {
        contractAddress: de.eth,
        entrypoint: "approve",
        calldata: [de.privacy.address, approvalAmount, 0n],
      },
    ]);

    // --- Approve STRK + ETH for each user ---
    for (const user of users) {
      await user.execute([
        {
          contractAddress: de.strk,
          entrypoint: "approve",
          calldata: [de.privacy.address, approvalAmount, 0n],
        },
        {
          contractAddress: de.eth,
          entrypoint: "approve",
          calldata: [de.privacy.address, approvalAmount, 0n],
        },
      ]);
    }

    // --- Round 1: Alice deposits STRK, transfers to 9 users (10 notes) ---
    const round1 = aliceTransfers
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(de.strk)
      .deposit({ amount: 500n, recipient: de.alice.address });
    for (const user of users) {
      round1.transfer({ recipient: user.address, amount: 50n });
    }
    const { callAndProof: r1 } = await round1.execute();
    await devnet.executeOutside(r1);

    // --- Round 2: Alice deposits ETH, transfers to 9 users (10 notes) ---
    const round2 = aliceTransfers
      .build({
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(de.eth)
      .deposit({ amount: 500n, recipient: de.alice.address });
    for (const user of users) {
      round2.transfer({ recipient: user.address, amount: 50n });
    }
    const { callAndProof: r2 } = await round2.execute();
    await devnet.executeOutside(r2);

    // --- Round 3: Each user deposits 100 STRK + transfers 60 to Alice (18 notes) ---
    for (let i = 0; i < users.length; i++) {
      const { callAndProof } = await userTransfers[i]
        .build({
          autoRegister: true,
          autoSetup: true,
          autoDiscover: { notes: "refresh", channels: "refresh" },
        })
        .with(de.strk)
        .deposit({ amount: 100n, recipient: users[i].address })
        .transfer({ recipient: de.alice.address, amount: 60n })
        .execute();
      await devnet.executeOutside(callAndProof);
    }

    // --- Round 4: Each user deposits 100 ETH + transfers 60 to Alice (18 notes) ---
    for (let i = 0; i < users.length; i++) {
      const { callAndProof } = await userTransfers[i]
        .build({
          autoSetup: true,
          autoDiscover: { notes: "refresh", channels: "refresh" },
        })
        .with(de.eth)
        .deposit({ amount: 100n, recipient: users[i].address })
        .transfer({ recipient: de.alice.address, amount: 60n })
        .execute();
      await devnet.executeOutside(callAndProof);
    }

    // --- Round 5: Alice re-distributes STRK to users (10 notes, ~10 spent) ---
    // No deposit → needs autoSelectNotes + explicit surplusTo for change.
    // All channels already exist from rounds 1-4, no autoSetup needed.
    const round5 = aliceTransfers
      .build({
        autoSelectNotes: "naive",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .surplusTo(de.alice.address)
      .with(de.strk);
    for (const user of users) {
      round5.transfer({ recipient: user.address, amount: 30n });
    }
    const { callAndProof: r5 } = await round5.execute();
    await devnet.executeOutside(r5);

    // --- Round 6: Alice re-distributes ETH to users (10 notes, ~10 spent) ---
    const round6 = aliceTransfers
      .build({
        autoSelectNotes: "naive",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .surplusTo(de.alice.address)
      .with(de.eth);
    for (const user of users) {
      round6.transfer({ recipient: user.address, amount: 30n });
    }
    const { callAndProof: r6 } = await round6.execute();
    await devnet.executeOutside(r6);

    // --- Round 7: Each user deposits 80 STRK + transfers 50 to Alice (18 notes, ~18 spent) ---
    for (let i = 0; i < users.length; i++) {
      const { callAndProof } = await userTransfers[i]
        .build({
          autoSetup: true,
          autoDiscover: { notes: "refresh", channels: "refresh" },
        })
        .with(de.strk)
        .deposit({ amount: 80n, recipient: users[i].address })
        .transfer({ recipient: de.alice.address, amount: 50n })
        .execute();
      await devnet.executeOutside(callAndProof);
    }

    // --- Sync indexer ---
    await fetch(devnet.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_createBlock" }),
    });
    await env.indexer.waitForNewLog("New block #", 30_000);
  });

  afterAll(async () => {
    env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it("alice discovers notes across multiple senders and tokens", async () => {
    const { env: de } = env;
    const indexerDiscovery = new IndexerDiscoveryProvider(env.indexer.apiUrl);
    const chainId = constants.StarknetChainId.SN_SEPOLIA;

    const aliceDiscover = createPrivateTransfers({
      account: de.alice,
      viewingKeyProvider: { getViewingKey: () => ALICE_KEY },
      provingProvider: new CallMockProofProvider(de.provider, chainId),
      discoveryProvider: indexerDiscovery,
      poolContractAddress: de.privacy.address,
    });

    const { notes } = await aliceDiscover.discoverNotes();

    // Alice should have notes in both STRK and ETH
    const strkNotes = notes.get(BigInt(de.strk));
    const ethNotes = notes.get(BigInt(de.eth));
    expect(strkNotes).toBeDefined();
    expect(ethNotes).toBeDefined();

    // Total unspent should be substantial (sanity check)
    const totalUnspent = (strkNotes?.length ?? 0) + (ethNotes?.length ?? 0);
    expect(totalUnspent).toBeGreaterThanOrEqual(5);
  });

  it("alice discovers outgoing channels to all 9 users", async () => {
    const { env: de } = env;
    const indexerDiscovery = new IndexerDiscoveryProvider(env.indexer.apiUrl);
    const chainId = constants.StarknetChainId.SN_SEPOLIA;

    const aliceDiscover = createPrivateTransfers({
      account: de.alice,
      viewingKeyProvider: { getViewingKey: () => ALICE_KEY },
      provingProvider: new CallMockProofProvider(de.provider, chainId),
      discoveryProvider: indexerDiscovery,
      poolContractAddress: de.privacy.address,
    });

    const allAddresses = [de.alice.address, ...users.map((u) => u.address)];
    const { channels } = await aliceDiscover.discoverChannels(allAddresses);

    // Self-channel + all 9 users
    expect(channels.has(BigInt(de.alice.address))).toBe(true);
    for (const user of users) {
      expect(channels.has(BigInt(user.address))).toBe(true);
    }
  });

  it("every user can discover their own notes", async () => {
    const { env: de } = env;
    const indexerDiscovery = new IndexerDiscoveryProvider(env.indexer.apiUrl);
    const chainId = constants.StarknetChainId.SN_SEPOLIA;

    for (let i = 0; i < users.length; i++) {
      const userDiscover = createPrivateTransfers({
        account: users[i],
        viewingKeyProvider: { getViewingKey: () => userKey(i) },
        provingProvider: new CallMockProofProvider(de.provider, chainId),
        discoveryProvider: indexerDiscovery,
        poolContractAddress: de.privacy.address,
      });

      const { notes } = await userDiscover.discoverNotes();
      // Each user received notes in at least one token
      let totalNotes = 0;
      for (const [, tokenNotes] of notes) {
        totalNotes += tokenNotes.length;
      }
      expect(totalNotes).toBeGreaterThanOrEqual(1);
    }
  });

  it("every user discovers their channel to alice", async () => {
    const { env: de } = env;
    const indexerDiscovery = new IndexerDiscoveryProvider(env.indexer.apiUrl);
    const chainId = constants.StarknetChainId.SN_SEPOLIA;

    for (let i = 0; i < users.length; i++) {
      const userDiscover = createPrivateTransfers({
        account: users[i],
        viewingKeyProvider: { getViewingKey: () => userKey(i) },
        provingProvider: new CallMockProofProvider(de.provider, chainId),
        discoveryProvider: indexerDiscovery,
        poolContractAddress: de.privacy.address,
      });

      const { channels } = await userDiscover.discoverChannels([de.alice.address]);
      expect(channels.has(BigInt(de.alice.address))).toBe(true);
    }
  });
});
