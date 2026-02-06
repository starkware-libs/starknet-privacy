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

    // Create a block so the indexer catches up with the transaction blocks
    await fetch(devnet.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_createBlock" }),
    });
    await env.indexer.waitForNewLog("New block #", 15_000);

    // TODO: Replace raw endpoint calls with SDK discovery provider flow.
    // Next step: implement IndexerDiscoveryProvider (implements DiscoveryProviderInterface)
    // and run discovery via transfers.alice.discoverNotes() / discoverChannels() instead.
    // The harness should inject IndexerDiscoveryProvider into transfers so the e2e test
    // exercises the real wallet flow end-to-end.

    // Incoming sync: Alice should see at least 1 incoming channel (self-channel from deposit)
    const incomingResp = await fetch(`${env.indexer.apiUrl}/v1/sync/incoming_state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient_address: de.alice.address,
        decryption_key: "0xa11ce",
      }),
    });
    expect(incomingResp.ok).toBe(true);
    const incoming = await incomingResp.json() as Record<string, unknown>;

    expect(incoming.block_ref).toBeDefined();
    expect(Object.keys(incoming.channels as object).length).toBeGreaterThanOrEqual(1);

    // Outgoing sync: Alice should see 2 outgoing channels (self-channel + transfer to Bob)
    const outgoingResp = await fetch(`${env.indexer.apiUrl}/v1/sync/outgoing_state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender_address: de.alice.address,
        viewing_key: "0xa11ce",
      }),
    });
    expect(outgoingResp.ok).toBe(true);
    const outgoing = await outgoingResp.json() as Record<string, unknown>;

    expect(outgoing.block_ref).toBeDefined();
    expect(Object.keys(outgoing.channels as object).length).toBeGreaterThanOrEqual(2);
  });
});
