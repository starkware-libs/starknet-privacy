import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Devnet } from "starknet-sdk/testing";
import { createE2eTestEnv, type E2eTestEnv } from "../src/harness.js";

describe("E2E Smoke", () => {
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

  it("deposit + transfer are discoverable via indexer", async () => {
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
      .deposit({ amount: 100n, recipient: de.alice.address })
      .transfer({ recipient: de.bob.address, amount: 50n })
      .execute();

    await devnet.executeOutside(callAndProof);

    // Wait for the indexer to process the new blocks
    await env.indexer.waitForLog("New block #", 15_000);

    // TODO: Replace raw endpoint call with SDK discovery provider flow.
    // Next step: implement IndexerDiscoveryProvider (implements DiscoveryProviderInterface)
    // and run discovery via transfers.alice.discoverNotes() / discoverChannels() instead.
    // The harness should inject IndexerDiscoveryProvider into transfers so the e2e test
    // exercises the real wallet flow end-to-end.
    const resp = await fetch(`${env.indexer.apiUrl}/v1/discovery/incoming/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient_address: de.alice.address,
        decryption_key: "0xa11ce",
      }),
    });
    expect(resp.ok).toBe(true);
    const response = await resp.json() as Record<string, unknown>;

    expect(response.block_ref).toBeDefined();
    expect(Object.keys(response.channels as object).length).toBeGreaterThanOrEqual(1);
  });
});
