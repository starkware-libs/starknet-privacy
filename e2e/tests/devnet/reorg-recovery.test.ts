import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Devnet } from "@starkware-libs/starknet-privacy-sdk/testing";
import {
  createEmptyRegistry,
  AddressMap,
} from "@starkware-libs/starknet-privacy-sdk";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";

describe("E2E Reorg Recovery", () => {
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

  it("recovers from a simulated reorg during compile", async () => {
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

    // Sync indexer with the new block
    await env.indexer.waitForBlock(devnet.url);

    // Prepare a registry with a fake cursor to simulate a reorged block.
    // The fake blockId will be sent as last_known_block to the indexer,
    // which will respond with HTTP 409 (BLOCK_REORGED).
    // NotesCursor fields are @internal (stripped from .d.ts), so we cast through `any`.
    const registry = createEmptyRegistry();
    registry.cursor = {
      blockId: "0xdeadbeef",
      incomingChannels: new AddressMap(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Second operation: withdraw triggers a deficit, forcing note discovery.
    // Note discovery sends the fake cursor → indexer returns 409 →
    // ReorgError → compiler clears registry → retries from scratch → succeeds.
    const { registry: updatedRegistry } = await transfers.alice
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
    // - Registry cursor was cleared and re-populated with a valid blockId
    expect(updatedRegistry.cursor).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((updatedRegistry.cursor as any).blockId).not.toBe("0xdeadbeef");
    // - Notes were re-discovered (Alice has a 50 STRK change note)
    expect(updatedRegistry.notes.size).toBeGreaterThanOrEqual(1);
  });
});
