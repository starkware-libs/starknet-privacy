import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { constants } from "starknet";
import {
  Devnet,
  CallMockProofProvider,
  IndexerDiscoveryProvider,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import {
  createPrivateTransfers,
  SetupRequirement,
} from "@starkware-libs/starknet-privacy-sdk";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";
import { E2E_TIMEOUTS } from "../../src/timeouts.js";

describe("E2E Smoke", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet);
  });

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it("deposit + transfer are discoverable via indexer", async () => {
    const { env: de, transfers } = env;

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

    // Create a block so the indexer catches up with the transaction blocks
    await fetch(devnet.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "devnet_createBlock",
      }),
    });
    await env.indexer.waitForNewLog("New block #", E2E_TIMEOUTS.indexerLog);

    // Verify discovery via IndexerDiscoveryProvider (exercises SDK → indexer end-to-end)
    const indexerDiscovery = new IndexerDiscoveryProvider(
      env.indexer.apiUrl,
      de.privacy.address,
    );
    const aliceIndexer = createPrivateTransfers({
      account: de.alice,
      viewingKeyProvider: { getViewingKey: async () => BigInt("0xA11CE") },
      provingProvider: new CallMockProofProvider(
        de.provider,
        constants.StarknetChainId.SN_SEPOLIA,
      ),
      discoveryProvider: indexerDiscovery,
      poolContractAddress: de.privacy.address,
    });

    const { notes } = await aliceIndexer.discoverNotes();
    expect(notes.size).toBeGreaterThanOrEqual(1); // at least STRK
    const strkNotes = notes.get(BigInt(de.strk));
    expect(strkNotes).toBeDefined();
    expect(strkNotes!.length).toBeGreaterThanOrEqual(1);
    expect(strkNotes![0].amount).toBe(50n); // Alice's change note

    const { channels } = await aliceIndexer.discoverChannels([
      de.alice.address,
      de.bob.address,
    ]);
    expect(channels).toBeDefined();
    expect(channels!.size).toBeGreaterThanOrEqual(2); // self-channel + Bob
    expect(channels!.has(BigInt(de.alice.address))).toBe(true);
    expect(channels!.has(BigInt(de.bob.address))).toBe(true);

    const req = await aliceIndexer.discoverRequirement(de.bob.address, de.strk);
    expect(req).toBe(SetupRequirement.Ready);

    // --- Bob's incoming discovery ---
    const bobIndexer = createPrivateTransfers({
      account: de.bob,
      viewingKeyProvider: { getViewingKey: async () => BigInt("0xB0B") },
      provingProvider: new CallMockProofProvider(
        de.provider,
        constants.StarknetChainId.SN_SEPOLIA,
      ),
      discoveryProvider: indexerDiscovery,
      poolContractAddress: de.privacy.address,
    });

    // Bob should discover 1 incoming note: 50 STRK from Alice
    const { notes: bobNotes } = await bobIndexer.discoverNotes();
    expect(bobNotes.size).toBeGreaterThanOrEqual(1);
    const bobStrkNotes = bobNotes.get(BigInt(de.strk));
    expect(bobStrkNotes).toBeDefined();
    expect(bobStrkNotes!.length).toBe(1);
    expect(bobStrkNotes![0].amount).toBe(50n);
  });
});
