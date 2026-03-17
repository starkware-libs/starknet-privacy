import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
import { PrivateRegistry, AddressMap } from "@starkware-libs/starknet-privacy-sdk";
import { createE2eTestEnv, type E2eTestEnv } from "../src/harness.js";

describe("E2E Reorg Recovery", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet);
  });

  afterAll(async () => {
    env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  async function createBlock() {
    await fetch(devnet.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_createBlock" }),
    });
  }

  it("recovers from a simulated reorg during compile", async () => {
    const { env: de, transfers } = env;

    // Approve STRK spending
    await de.alice.execute({
      contractAddress: de.strk,
      entrypoint: "approve",
      calldata: [de.privacy.address, 100n, 0n],
    });

    // Register bob
    const { callAndProof: bobReg } = await transfers.bob.build().register().execute();
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

    // Sync indexer with the new block
    await createBlock();
    await env.indexer.waitForNewLog("New block #", 15_000);

    // Prepare a registry with a fake cursor to simulate a reorged block.
    // The fake blockId will be sent as last_known_block to the indexer,
    // which will respond with HTTP 409 (BLOCK_REORGED).
    // NotesCursor fields are @internal (stripped from .d.ts), so we cast through `any`.
    const registry = new PrivateRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry.notesCursor = { blockId: "0xdeadbeef", incomingChannels: new AddressMap() } as any;

    // Second operation: withdraw triggers a deficit, forcing note discovery.
    // Note discovery sends the fake cursor → indexer returns 409 →
    // ReorgError → compiler clears registry → retries from scratch → succeeds.
    const { registryUpdate } = await transfers.alice
      .build({
        autoDiscover: { notes: "refresh", channels: "refresh" },
        autoSelectNotes: "naive",
        autoSetup: true,
        registry,
      })
      .with(de.strk)
      .withdraw({ amount: 50n, recipient: de.alice.address })
      .execute();

    // Verify recovery succeeded:
    // - No error thrown (reorg was handled internally)
    // - Registry notesCursor was cleared and re-populated with a valid blockId
    // (the compiler clears and re-discovers, so registry.notesCursor is updated)
    expect(registry.notesCursor).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((registry.notesCursor as any).blockId).not.toBe("0xdeadbeef");
    // - Notes were re-discovered (registryUpdate has Alice's change note)
    expect(registryUpdate.notes.size).toBeGreaterThanOrEqual(1);
  });
});
