import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";

describe("E2E provingBlockId", () => {
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

  it("discovery and prover respect provingBlockId", async () => {
    const { env: de, transfers } = env;

    // 1. Approve + deposit 100 STRK to Alice
    await de.alice.execute({
      contractAddress: de.strk,
      entrypoint: "approve",
      calldata: [de.privacy.address, 100n, 0n],
    });

    const { callAndProof: deposit1 } = await transfers.alice
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(de.strk)
      .deposit({ amount: 100n })
      .surplusTo(de.alice.address)
      .execute();

    await devnet.executeOutside(deposit1);
    await env.indexer.waitForBlock(devnet.url);

    // 2. Record current block number (after first deposit is confirmed)
    const oldBlock = await de.provider.getBlockNumber();

    // 3. Mine 10 empty blocks to advance the chain
    for (let blockIndex = 0; blockIndex < 10; blockIndex++) {
      await env.indexer.waitForBlock(devnet.url);
    }

    // 4. Approve + deposit 200 more STRK to Alice
    await de.alice.execute({
      contractAddress: de.strk,
      entrypoint: "approve",
      calldata: [de.privacy.address, 200n, 0n],
    });

    const { callAndProof: deposit2 } = await transfers.alice
      .build({
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(de.strk)
      .deposit({ amount: 200n })
      .surplusTo(de.alice.address)
      .execute();

    await devnet.executeOutside(deposit2);
    await env.indexer.waitForBlock(devnet.url);

    // 5. Withdraw the 100 STRK from the first deposit using old block as provingBlockId.
    //    Discovery at oldBlock should only see the 100 STRK note.
    const { callAndProof: withdrawal } = await transfers.alice
      .build({
        autoSelectNotes: "naive",
        autoDiscover: { notes: "refresh", channels: "refresh" },
        provingBlockId: oldBlock,
      })
      .with(de.strk)
      .withdraw({ amount: 100n, recipient: de.alice.address })
      .surplusTo(de.alice.address)
      .execute();

    await devnet.executeOutside(withdrawal);
    await env.indexer.waitForBlock(devnet.url);

    // 6. Discover notes at the latest state — Alice should still have the
    //    200 STRK from the second deposit (which was invisible at oldBlock).
    const { notes } = await transfers.alice.discoverNotes();
    const strkNotes = notes.get(BigInt(de.strk));
    expect(strkNotes).toBeDefined();
    expect(strkNotes!.length).toBeGreaterThanOrEqual(1);

    const totalPrivateBalance = strkNotes!.reduce(
      (sum, note) => sum + note.amount,
      0n,
    );
    expect(totalPrivateBalance).toBe(200n);
  });
});
