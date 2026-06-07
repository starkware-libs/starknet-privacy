import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { constants } from "starknet";
import {
  Devnet,
  CallMockProofProvider,
  IndexerDiscoveryProvider,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import { createPrivateTransfers } from "@starkware-libs/starknet-privacy-sdk";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";

describe("Discovery pagination with small budget", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;

  beforeAll(async () => {
    // Set SERVER_BUDGET before spawning the indexer so it inherits the env var.
    // min_server_budget(30) = 89, forcing multi-round pagination.
    process.env.SERVER_BUDGET = "89";
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet);
    delete process.env.SERVER_BUDGET;

    const { env: de, transfers } = env;

    // Approve STRK spending
    await de.alice.execute({
      contractAddress: de.strk,
      entrypoint: "approve",
      calldata: [de.privacy.address, 100n, 0n],
    });

    // Register Bob
    const { callAndProof: bobReg } = await transfers.bob
      .build()
      .register()
      .execute();
    await devnet.executeOutside(bobReg);

    // Alice: deposit 100 STRK + transfer 50 to Bob
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

    // Create a block and wait for the indexer to process it
    await env.indexer.waitForBlock(devnet.url);
  });

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it("outgoing channels discovered despite forced pagination", async () => {
    const { env: de } = env;
    const discovery = new IndexerDiscoveryProvider(
      env.indexer.apiUrl,
      de.privacy.address,
    );

    const aliceTransfers = createPrivateTransfers({
      account: de.alice,
      viewingKeyProvider: { getViewingKey: async () => BigInt("0xA11CE") },
      provingProvider: new CallMockProofProvider(
        de.provider,
        constants.StarknetChainId.SN_SEPOLIA,
      ),
      discoveryProvider: discovery,
      poolContractAddress: de.privacy.address,
      // Source-built devnet pool — unpinned class hash; force compatibility calldata.
      poolMode: "compatibility",
    });

    // total-only: exercises total_n_channels
    const { total } = await aliceTransfers.discoverChannels("total-only");
    expect(total).toBe(2); // self-channel + Bob

    // full discovery: exercises multi-round pagination
    const { channels } = await aliceTransfers.discoverChannels([
      de.alice.address,
      de.bob.address,
    ]);
    expect(channels).toBeDefined();
    expect(channels!.size).toBe(2);
    expect(channels!.has(BigInt(de.alice.address))).toBe(true);
    expect(channels!.has(BigInt(de.bob.address))).toBe(true);
  });

  it("incoming notes discovered despite forced pagination", async () => {
    const { env: de } = env;
    const discovery = new IndexerDiscoveryProvider(
      env.indexer.apiUrl,
      de.privacy.address,
    );

    // Alice incoming: 1 note (50 STRK change)
    const aliceTransfers = createPrivateTransfers({
      account: de.alice,
      viewingKeyProvider: { getViewingKey: async () => BigInt("0xA11CE") },
      provingProvider: new CallMockProofProvider(
        de.provider,
        constants.StarknetChainId.SN_SEPOLIA,
      ),
      discoveryProvider: discovery,
      poolContractAddress: de.privacy.address,
      // Source-built devnet pool — unpinned class hash; force compatibility calldata.
      poolMode: "compatibility",
    });

    const { notes } = await aliceTransfers.discoverNotes();
    const strkNotes = notes.get(BigInt(de.strk));
    expect(strkNotes).toBeDefined();
    expect(strkNotes![0].amount).toBe(50n);

    // Bob incoming: 1 note (50 STRK from Alice)
    const bobTransfers = createPrivateTransfers({
      account: de.bob,
      viewingKeyProvider: { getViewingKey: async () => BigInt("0xB0B") },
      provingProvider: new CallMockProofProvider(
        de.provider,
        constants.StarknetChainId.SN_SEPOLIA,
      ),
      discoveryProvider: discovery,
      poolContractAddress: de.privacy.address,
      // Source-built devnet pool — unpinned class hash; force compatibility calldata.
      poolMode: "compatibility",
    });

    const { notes: bobNotes } = await bobTransfers.discoverNotes();
    expect(bobNotes.get(BigInt(de.strk))![0].amount).toBe(50n);

    // Verify total_n_notes in wire-level cursor via raw API call.
    // NotesCursor internal fields are stripped by stripInternal, so we
    // check the JSON response directly.
    const rawResp = await fetch(
      `${env.indexer.apiUrl}/v1/sync/incoming_state`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_address: de.privacy.address,
          recipient_address: de.alice.address,
          viewing_key: "0xA11CE",
          cursor: {},
        }),
      },
    );
    const rawBody = (await rawResp.json()) as {
      cursor: {
        channels?: Record<
          string,
          { subchannels?: Record<string, { total_n_notes?: number }> }
        >;
      };
    };
    const channelEntries = Object.values(rawBody.cursor.channels ?? {});
    expect(channelEntries.length).toBeGreaterThan(0);
    for (const channel of channelEntries) {
      for (const subchannel of Object.values(channel.subchannels ?? {})) {
        expect(subchannel.total_n_notes).toBe(1);
      }
    }
  });
});
